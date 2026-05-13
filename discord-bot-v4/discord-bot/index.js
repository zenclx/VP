require('dotenv').config();
require('./keepalive');
const { Client, GatewayIntentBits, Collection, REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');
const db = require('./database');
const { buildScoreboardEmbed } = require('./utils');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
client.commands = new Collection();

const commandFiles = fs.readdirSync(path.join(__dirname, 'commands')).filter(f => f.endsWith('.js'));
const commandsData = [];
for (const file of commandFiles) {
  const cmd = require(`./commands/${file}`);
  if (cmd.data && cmd.execute) {
    client.commands.set(cmd.data.name, cmd);
    commandsData.push(cmd.data.toJSON());
  }
}

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    console.log('Registering slash commands...');
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commandsData });
    console.log('✅ Commands registered!');
  } catch (e) { console.error('Failed to register commands:', e); }
}

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();
});

client.on('interactionCreate', async interaction => {
  if (interaction.isAutocomplete()) {
    const cmd = client.commands.get(interaction.commandName);
    if (cmd?.autocomplete) try { await cmd.autocomplete(interaction); } catch {}
    return;
  }

  if (interaction.isChatInputCommand()) {
    const cmd = client.commands.get(interaction.commandName);
    if (!cmd) return;
    try { await cmd.execute(interaction); }
    catch (e) {
      console.error(e);
      const p = { content: '❌ An error occurred.', ephemeral: true };
      if (interaction.replied || interaction.deferred) await interaction.followUp(p).catch(() => {});
      else await interaction.reply(p).catch(() => {});
    }
    return;
  }

  if (!interaction.isButton()) return;
  const { customId } = interaction;

  // ── Scoreboard: reset ───────────────────────────────────────────────
  if (customId.startsWith('reset_confirm_')) {
    const sbId = customId.replace('reset_confirm_', '');
    const data = db.get();
    const sb = data.scoreboards[sbId];
    if (!sb) return interaction.update({ content: '❌ Not found.', components: [] });
    sb.scores = {};
    data.scoreboards[sbId] = sb;
    db.set(data);
    try { const ch = await client.channels.fetch(sb.channelId); const msg = await ch.messages.fetch(sb.messageId); await msg.edit({ embeds: [buildScoreboardEmbed(sb)] }); } catch {}
    return interaction.update({ content: `✅ **${sb.name}** has been reset.`, components: [] });
  }
  if (customId === 'reset_cancel') return interaction.update({ content: 'Cancelled.', components: [] });

  // ── Scoreboard: delete ──────────────────────────────────────────────
  if (customId.startsWith('delete_confirm_')) {
    const sbId = customId.replace('delete_confirm_', '');
    const data = db.get();
    const sb = data.scoreboards[sbId];
    if (!sb) return interaction.update({ content: '❌ Not found.', components: [] });
    try { const ch = await client.channels.fetch(sb.channelId); const msg = await ch.messages.fetch(sb.messageId); await msg.delete(); } catch {}
    const name = sb.name;
    delete data.scoreboards[sbId];
    db.set(data);
    return interaction.update({ content: `🗑️ **${name}** deleted.`, components: [] });
  }
  if (customId === 'delete_cancel') return interaction.update({ content: 'Cancelled.', components: [] });

  // ── Queue buttons ───────────────────────────────────────────────────
  const {
    buildQueueEmbed, timers, startBracket, canManageMatch, scheduleChannelDelete,
    buildNextRound, fetchDisplayNames, postOrUpdateBracket, logMatchResult,
    buildBracketComponents, buildBracketTextEmbed, makeBracketAttachment
  } = require('./commands/creatematch');

  function makeJoinRow(matchId) {
    const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`join_queue_${matchId}`).setLabel('Join Queue').setStyle(ButtonStyle.Success).setEmoji('⚔️'),
      new ButtonBuilder().setCustomId(`leave_queue_${matchId}`).setLabel('Leave Queue').setStyle(ButtonStyle.Secondary).setEmoji('🚪'),
      new ButtonBuilder().setCustomId(`addminute_${matchId}`).setLabel('+1 Minute').setStyle(ButtonStyle.Secondary).setEmoji('⏱️'),
      new ButtonBuilder().setCustomId(`forcestart_${matchId}`).setLabel('Force Start').setStyle(ButtonStyle.Danger).setEmoji('🚀'),
    );
  }

  if (customId.startsWith('join_queue_')) {
    const matchId = customId.replace('join_queue_', '');
    const data = db.get();
    const match = data.matches[matchId];
    if (!match || match.status !== 'queuing') return interaction.reply({ content: '❌ Queue is closed.', ephemeral: true });
    if (match.queue.includes(interaction.user.id)) return interaction.reply({ content: '⚠️ You are already in the queue!', ephemeral: true });
    match.queue.push(interaction.user.id);
    data.matches[matchId] = match;
    db.set(data);
    return interaction.update({ embeds: [buildQueueEmbed(match)], components: [makeJoinRow(matchId)] });
  }

  if (customId.startsWith('leave_queue_')) {
    const matchId = customId.replace('leave_queue_', '');
    const data = db.get();
    const match = data.matches[matchId];
    if (!match || match.status !== 'queuing') return interaction.reply({ content: '❌ Queue is closed.', ephemeral: true });
    match.queue = match.queue.filter(id => id !== interaction.user.id);
    data.matches[matchId] = match;
    db.set(data);
    return interaction.update({ embeds: [buildQueueEmbed(match)], components: [makeJoinRow(matchId)] });
  }

  if (customId.startsWith('addminute_')) {
    const matchId = customId.replace('addminute_', '');
    if (!canManageMatch(interaction.member)) return interaction.reply({ content: '❌ Staff only.', ephemeral: true });
    const data = db.get();
    const match = data.matches[matchId];
    if (!match || match.status !== 'queuing') return interaction.reply({ content: '❌ Queue closed.', ephemeral: true });
    match.endsAt += 60000;
    data.matches[matchId] = match;
    db.set(data);
    const t = timers.get(matchId);
    if (t) {
      clearTimeout(t.timer);
      const newTimer = setTimeout(async () => { clearInterval(t.interval); await startBracket(client, matchId); }, match.endsAt - Date.now());
      timers.set(matchId, { ...t, timer: newTimer });
    }
    return interaction.update({ embeds: [buildQueueEmbed(match)], components: [makeJoinRow(matchId)] });
  }

  if (customId.startsWith('forcestart_')) {
    const matchId = customId.replace('forcestart_', '');
    if (!canManageMatch(interaction.member)) return interaction.reply({ content: '❌ Staff only.', ephemeral: true });
    const data = db.get();
    const match = data.matches[matchId];
    if (!match || match.status !== 'queuing') return interaction.reply({ content: '❌ Queue not open.', ephemeral: true });
    const minPlayers = match.type === '1v1' ? 4 : 6;
    if (match.queue.length < minPlayers) return interaction.reply({ content: `❌ Need **${minPlayers}** players. Have **${match.queue.length}**.`, ephemeral: true });
    const t = timers.get(matchId);
    if (t) { clearTimeout(t.timer); clearInterval(t.interval); timers.delete(matchId); }
    await interaction.deferUpdate();
    await startBracket(client, matchId);
    return;
  }

  // ── Winner selection ────────────────────────────────────────────────
  if (customId.startsWith('win_')) {
    if (!canManageMatch(interaction.member)) return interaction.reply({ content: '❌ Staff only.', ephemeral: true });

    const withoutPrefix = customId.slice(4);
    const segments = withoutPrefix.split('_');
    const winnerId = segments[segments.length - 1];
    const matchIndex = parseInt(segments[segments.length - 2]);
    const round = parseInt(segments[segments.length - 3]);
    const matchId = segments.slice(0, segments.length - 3).join('_');

    const data = db.get();
    const match = data.matches[matchId];
    if (!match) return interaction.reply({ content: '❌ Match not found.', ephemeral: true });

    const bracketMatch = match.bracket[round][matchIndex];
    if (!bracketMatch) return interaction.reply({ content: '❌ Match slot not found.', ephemeral: true });
    if (bracketMatch.winner) return interaction.reply({ content: '⚠️ Winner already selected.', ephemeral: true });

    const loserId = bracketMatch.p1 === winnerId ? bracketMatch.p2 : bracketMatch.p1;
    bracketMatch.winner = winnerId;

    // Credit win to scoreboard
    if (match.scoreboardName) {
      const sb = Object.values(data.scoreboards || {}).find(
        s => s.guildId === match.guildId && s.name.toLowerCase() === match.scoreboardName.toLowerCase()
      );
      if (sb) {
        sb.scores[winnerId] = (sb.scores[winnerId] || 0) + 1;
        data.scoreboards[sb.id] = sb;
        try {
          const ch = await client.channels.fetch(sb.channelId);
          const msg = await ch.messages.fetch(sb.messageId);
          await msg.edit({ embeds: [buildScoreboardEmbed(sb)] });
        } catch {}
      }
    }

    // Log match result
    await logMatchResult(client, match, winnerId, loserId ? [loserId] : []);

    const roundComplete = match.bracket[round].every(m => m.winner !== null);

    if (roundComplete) {
      const allWinners = match.bracket[round].map(m => m.winner);
      // De-dupe (byes already have winner set)
      const uniqueWinners = [...new Set(allWinners)];

      if (uniqueWinners.length === 1) {
        // 🏆 Tournament over
        const champion = uniqueWinners[0];
        match.status = 'complete';
        match.champion = champion;
        data.matches[matchId] = match;
        db.set(data);

        // Update bracket image one last time
        await postOrUpdateBracket(client, match);

        // Send champion announcement then schedule delete
        if (match.privateChannelId) {
          try {
            const ch = await client.channels.fetch(match.privateChannelId);
            const { EmbedBuilder } = require('discord.js');
            const champTag = match.bracket[round].find(m => m.winner === champion)?.p1Tag ||
                             match.bracket[round].find(m => m.winner === champion)?.p2Tag || '';
            const finalEmbed = new EmbedBuilder()
              .setTitle('🏆 Tournament Complete!')
              .setColor(0xffd700)
              .setDescription(`👑 **Champion: <@${champion}>**${champTag ? ` (${champTag})` : ''}\n\nGG to all players!${match.prize ? `\n\n🎁 **Prize:** ${match.prize}` : ''}`)
              .setTimestamp();
            await ch.send({ embeds: [finalEmbed] });
          } catch {}
          scheduleChannelDelete(client, match.privateChannelId);
        }

        return interaction.update({ content: `🏆 **Tournament over! Champion: <@${champion}>**`, embeds: [], components: [] });
      }

      // Build next round
      const nextRound = buildNextRound(match.bracket[round]);
      match.bracket.push(nextRound);
      match.currentRound = round + 1;
      data.matches[matchId] = match;
      db.set(data);

      // Update bracket image
      await postOrUpdateBracket(client, match);
      return interaction.update({ content: `✅ Round ${round + 1} complete! Round ${round + 2} begins.`, embeds: [], components: [] });
    }

    // Round still going — update image
    data.matches[matchId] = match;
    db.set(data);
    await postOrUpdateBracket(client, match);
    return interaction.update({ content: `✅ Winner recorded for Match ${matchIndex + 1}.`, embeds: [], components: [] });
  }
});

client.login(process.env.DISCORD_TOKEN);
