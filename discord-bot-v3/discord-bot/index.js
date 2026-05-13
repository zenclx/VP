require('dotenv').config();
require('./keepalive');
const { Client, GatewayIntentBits, Collection, REST, Routes, PermissionFlagsBits } = require('discord.js');
const fs = require('fs');
const path = require('path');
const db = require('./database');
const { buildScoreboardEmbed } = require('./utils');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

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
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commandsData }
    );
    console.log('✅ Slash commands registered!');
  } catch (e) {
    console.error('Failed to register commands:', e);
  }
}

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();
});

client.on('interactionCreate', async interaction => {
  // Autocomplete
  if (interaction.isAutocomplete()) {
    const cmd = client.commands.get(interaction.commandName);
    if (cmd?.autocomplete) {
      try { await cmd.autocomplete(interaction); } catch (e) { console.error(e); }
    }
    return;
  }

  // Slash commands
  if (interaction.isChatInputCommand()) {
    const cmd = client.commands.get(interaction.commandName);
    if (!cmd) return;
    try {
      await cmd.execute(interaction);
    } catch (e) {
      console.error(e);
      const payload = { content: '❌ An error occurred.', ephemeral: true };
      if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => {});
      else await interaction.reply(payload).catch(() => {});
    }
    return;
  }

  // Buttons
  if (interaction.isButton()) {
    const { customId } = interaction;

    // ── Reset scoreboard ────────────────────────────────────────────────
    if (customId.startsWith('reset_confirm_')) {
      const sbId = customId.replace('reset_confirm_', '');
      const data = db.get();
      const sb = data.scoreboards[sbId];
      if (!sb) return interaction.update({ content: '❌ Scoreboard not found.', components: [] });
      sb.scores = {};
      data.scoreboards[sbId] = sb;
      db.set(data);
      try {
        const ch = await client.channels.fetch(sb.channelId);
        const msg = await ch.messages.fetch(sb.messageId);
        await msg.edit({ embeds: [buildScoreboardEmbed(sb)] });
      } catch {}
      return interaction.update({ content: `✅ **${sb.name}** has been reset.`, components: [] });
    }
    if (customId === 'reset_cancel') return interaction.update({ content: 'Reset cancelled.', components: [] });

    // ── Delete scoreboard ───────────────────────────────────────────────
    if (customId.startsWith('delete_confirm_')) {
      const sbId = customId.replace('delete_confirm_', '');
      const data = db.get();
      const sb = data.scoreboards[sbId];
      if (!sb) return interaction.update({ content: '❌ Not found.', components: [] });
      try {
        const ch = await client.channels.fetch(sb.channelId);
        const msg = await ch.messages.fetch(sb.messageId);
        await msg.delete();
      } catch {}
      const name = sb.name;
      delete data.scoreboards[sbId];
      db.set(data);
      return interaction.update({ content: `🗑️ **${name}** deleted.`, components: [] });
    }
    if (customId === 'delete_cancel') return interaction.update({ content: 'Cancelled.', components: [] });

    // ── Queue: join ─────────────────────────────────────────────────────
    if (customId.startsWith('join_queue_')) {
      const matchId = customId.replace('join_queue_', '');
      const data = db.get();
      const match = data.matches[matchId];
      if (!match || match.status !== 'queuing') return interaction.reply({ content: '❌ Queue is closed.', ephemeral: true });
      if (match.queue.includes(interaction.user.id)) return interaction.reply({ content: '⚠️ You are already in the queue!', ephemeral: true });

      match.queue.push(interaction.user.id);
      data.matches[matchId] = match;
      db.set(data);

      const { buildQueueEmbed } = require('./commands/creatematch');
      const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`join_queue_${matchId}`).setLabel('Join Queue').setStyle(ButtonStyle.Success).setEmoji('⚔️'),
        new ButtonBuilder().setCustomId(`leave_queue_${matchId}`).setLabel('Leave Queue').setStyle(ButtonStyle.Secondary).setEmoji('🚪'),
        new ButtonBuilder().setCustomId(`addminute_${matchId}`).setLabel('+1 Minute').setStyle(ButtonStyle.Secondary).setEmoji('⏱️'),
        new ButtonBuilder().setCustomId(`forcestart_${matchId}`).setLabel('Force Start').setStyle(ButtonStyle.Danger).setEmoji('🚀'),
      );
      return interaction.update({ embeds: [buildQueueEmbed(match)], components: [row] });
    }

    // ── Queue: leave ────────────────────────────────────────────────────
    if (customId.startsWith('leave_queue_')) {
      const matchId = customId.replace('leave_queue_', '');
      const data = db.get();
      const match = data.matches[matchId];
      if (!match || match.status !== 'queuing') return interaction.reply({ content: '❌ Queue is closed.', ephemeral: true });

      match.queue = match.queue.filter(id => id !== interaction.user.id);
      data.matches[matchId] = match;
      db.set(data);

      const { buildQueueEmbed } = require('./commands/creatematch');
      const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`join_queue_${matchId}`).setLabel('Join Queue').setStyle(ButtonStyle.Success).setEmoji('⚔️'),
        new ButtonBuilder().setCustomId(`leave_queue_${matchId}`).setLabel('Leave Queue').setStyle(ButtonStyle.Secondary).setEmoji('🚪'),
        new ButtonBuilder().setCustomId(`addminute_${matchId}`).setLabel('+1 Minute').setStyle(ButtonStyle.Secondary).setEmoji('⏱️'),
        new ButtonBuilder().setCustomId(`forcestart_${matchId}`).setLabel('Force Start').setStyle(ButtonStyle.Danger).setEmoji('🚀'),
      );
      return interaction.update({ embeds: [buildQueueEmbed(match)], components: [row] });
    }

    // ── Queue: add 1 minute ─────────────────────────────────────────────
    if (customId.startsWith('addminute_')) {
      const matchId = customId.replace('addminute_', '');
      const { canManageMatch, timers, buildQueueEmbed, startBracket } = require('./commands/creatematch');
      if (!canManageMatch(interaction.member)) {
        return interaction.reply({ content: '❌ Only staff can add time.', ephemeral: true });
      }

      const data = db.get();
      const match = data.matches[matchId];
      if (!match || match.status !== 'queuing') return interaction.reply({ content: '❌ Queue is closed.', ephemeral: true });

      match.endsAt += 60 * 1000;
      data.matches[matchId] = match;
      db.set(data);

      // Reset the auto-start timer
      const t = timers.get(matchId);
      if (t) {
        clearTimeout(t.timer);
        const newTimer = setTimeout(async () => {
          clearInterval(t.interval);
          await startBracket(client, matchId);
        }, match.endsAt - Date.now());
        timers.set(matchId, { ...t, timer: newTimer });
      }

      const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`join_queue_${matchId}`).setLabel('Join Queue').setStyle(ButtonStyle.Success).setEmoji('⚔️'),
        new ButtonBuilder().setCustomId(`leave_queue_${matchId}`).setLabel('Leave Queue').setStyle(ButtonStyle.Secondary).setEmoji('🚪'),
        new ButtonBuilder().setCustomId(`addminute_${matchId}`).setLabel('+1 Minute').setStyle(ButtonStyle.Secondary).setEmoji('⏱️'),
        new ButtonBuilder().setCustomId(`forcestart_${matchId}`).setLabel('Force Start').setStyle(ButtonStyle.Danger).setEmoji('🚀'),
      );
      return interaction.update({ embeds: [buildQueueEmbed(match)], components: [row] });
    }

    // ── Queue: force start ──────────────────────────────────────────────
    if (customId.startsWith('forcestart_')) {
      const matchId = customId.replace('forcestart_', '');
      const { canManageMatch, timers, startBracket } = require('./commands/creatematch');
      if (!canManageMatch(interaction.member)) {
        return interaction.reply({ content: '❌ Only staff can force start.', ephemeral: true });
      }

      const data = db.get();
      const match = data.matches[matchId];
      if (!match || match.status !== 'queuing') return interaction.reply({ content: '❌ Queue is not open.', ephemeral: true });

      const minPlayers = match.type === '1v1' ? 4 : 6;
      if (match.queue.length < minPlayers) {
        return interaction.reply({ content: `❌ Need at least **${minPlayers}** players to start. Currently: **${match.queue.length}**`, ephemeral: true });
      }

      const t = timers.get(matchId);
      if (t) { clearTimeout(t.timer); clearInterval(t.interval); timers.delete(matchId); }

      await interaction.deferUpdate();
      await startBracket(client, matchId);
      return;
    }

    // ── Winner selection ────────────────────────────────────────────────
    if (customId.startsWith('win_')) {
      const { canManageMatch, buildBracketEmbed, buildBracketComponents, logMatchResult } = require('./commands/creatematch');
      if (!canManageMatch(interaction.member)) {
        return interaction.reply({ content: '❌ Only authorized staff can select winners.', ephemeral: true });
      }

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

      // Log the result
      await logMatchResult(client, match, winnerId, loserId ? [loserId] : []);

      const roundComplete = match.bracket[round].every(m => m.winner !== null);

      if (roundComplete) {
        const winners = match.bracket[round].filter(m => !m.bye).map(m => m.winner);

        if (winners.length <= 1) {
          // Tournament over
          const champion = winners[0] || match.bracket[round][0].winner;
          match.status = 'complete';
          match.champion = champion;
          data.matches[matchId] = match;
          db.set(data);

          const { EmbedBuilder } = require('discord.js');
          const finalEmbed = new EmbedBuilder()
            .setTitle('🏆 Tournament Complete!')
            .setColor(0xffd700)
            .setDescription(`👑 **Champion:** <@${champion}>\n\nGG to all players!`)
            .setTimestamp();

          // Delete private channel after 60s
          if (match.privateChannelId) {
            setTimeout(async () => {
              try {
                const ch = await client.channels.fetch(match.privateChannelId);
                await ch.delete('Match complete');
              } catch {}
            }, 60000);
          }

          return interaction.update({ embeds: [finalEmbed], components: [] });
        }

        // Next round
        const nextRound = [];
        for (let i = 0; i < winners.length - 1; i += 2) {
          nextRound.push({ p1: winners[i], p2: winners[i+1], winner: null, p1Tag: null, p2Tag: null });
        }
        if (winners.length % 2 !== 0) {
          nextRound.push({ p1: winners[winners.length - 1], p2: null, winner: winners[winners.length - 1], bye: true });
        }

        try {
          const guild = await client.guilds.fetch(match.guildId);
          for (const m of nextRound) {
            if (m.p1) { try { const mem = await guild.members.fetch(m.p1); m.p1Tag = mem.displayName; } catch {} }
            if (m.p2) { try { const mem = await guild.members.fetch(m.p2); m.p2Tag = mem.displayName; } catch {} }
          }
        } catch {}

        match.bracket.push(nextRound);
        match.currentRound = round + 1;
        data.matches[matchId] = match;
        db.set(data);

        return interaction.update({
          embeds: [buildBracketEmbed(match, match.currentRound)],
          components: buildBracketComponents(match, match.currentRound)
        });
      }

      data.matches[matchId] = match;
      db.set(data);
      return interaction.update({
        embeds: [buildBracketEmbed(match, round)],
        components: buildBracketComponents(match, round)
      });
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
