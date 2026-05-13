const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  ChannelType,
} = require('discord.js');
const db = require('../database');
const { DARK_BLUE } = require('../utils');

const QUEUE_DURATION_MS = 5 * 60 * 1000;
const timers = new Map();

// Roles that can CREATE matches and SELECT winners
const MATCH_MANAGER_ROLES = ['1387600871377993820'];

function canManageMatch(member) {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return member.roles.cache.some(r => MATCH_MANAGER_ROLES.includes(r.id));
}

function buildQueueEmbed(match) {
  const typeLabel = match.type === '1v1' ? '1v1' : '2v2';
  const minPlayers = match.type === '1v1' ? 4 : 6;
  const timeLeft = Math.max(0, Math.round((match.endsAt - Date.now()) / 1000));
  const mins = Math.floor(timeLeft / 60);
  const secs = String(timeLeft % 60).padStart(2, '0');
  const playerMentions = match.queue.map(id => `<@${id}>`).join('\n') || '*None yet*';

  return new EmbedBuilder()
    .setTitle(`⚔️ ${typeLabel} Match Queue`)
    .setColor(DARK_BLUE)
    .addFields(
      { name: '👥 Players Queued', value: `${match.queue.length} joined\n${playerMentions}`, inline: true },
      { name: '⏳ Time Remaining', value: `${mins}m ${secs}s`, inline: true },
      { name: '📋 Minimum to start', value: `${minPlayers} players`, inline: true }
    )
    .setFooter({ text: 'Click Join Queue to enter! Host can force-start anytime.' })
    .setTimestamp();
}

function buildBracketEmbed(match, round) {
  const embed = new EmbedBuilder()
    .setTitle(`🏆 ${match.type.toUpperCase()} Bracket — Round ${round + 1}`)
    .setColor(DARK_BLUE)
    .setTimestamp();

  const currentRound = match.bracket[round];
  if (!currentRound || currentRound.length === 0) {
    embed.setDescription('*No matches in this round.*');
    return embed;
  }

  const lines = currentRound.map((m, i) => {
    if (m.bye) return `Match ${i+1}: <@${m.p1}> — *BYE (auto-advance)*`;
    if (m.winner) return `Match ${i+1}: <@${m.p1}> vs <@${m.p2}> → 🏅 <@${m.winner}>`;
    return `Match ${i+1}: <@${m.p1}> vs <@${m.p2}> — *Pending*`;
  });

  embed.setDescription(lines.join('\n'));
  embed.setFooter({ text: `Match ID: ${match.id}` });
  return embed;
}

function buildBracketComponents(match, round) {
  const currentRound = match.bracket[round];
  const rows = [];
  currentRound.forEach((m, i) => {
    if (!m.winner && !m.bye) {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`win_${match.id}_${round}_${i}_${m.p1}`)
          .setLabel(`M${i+1}: ${m.p1Tag || 'Player 1'} wins`)
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`win_${match.id}_${round}_${i}_${m.p2}`)
          .setLabel(`M${i+1}: ${m.p2Tag || 'Player 2'} wins`)
          .setStyle(ButtonStyle.Primary)
      );
      rows.push(row);
    }
  });
  return rows.slice(0, 5);
}

function generateBracket(players) {
  const shuffled = [...players].sort(() => Math.random() - 0.5);
  const round = [];
  for (let i = 0; i < shuffled.length - 1; i += 2) {
    round.push({ p1: shuffled[i], p2: shuffled[i+1], winner: null, p1Tag: null, p2Tag: null });
  }
  if (shuffled.length % 2 !== 0) {
    round.push({ p1: shuffled[shuffled.length - 1], p2: null, winner: shuffled[shuffled.length - 1], bye: true });
  }
  return [round];
}

async function createMatchChannel(client, match) {
  try {
    const guild = await client.guilds.fetch(match.guildId);
    const overwrites = [
      { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
      ...match.queue.map(id => ({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] })),
      ...MATCH_MANAGER_ROLES.map(id => ({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] })),
    ];

    const channel = await guild.channels.create({
      name: `match-${match.id.split('-').pop()}`,
      type: ChannelType.GuildText,
      permissionOverwrites: overwrites,
      topic: `Private match channel | Match ID: ${match.id}`,
    });

    return channel;
  } catch (e) {
    console.error('Failed to create match channel:', e.message);
    return null;
  }
}

async function logMatchResult(client, match, winnerId, loserIds) {
  try {
    const data = db.get();
    const guildId = match.guildId;
    if (!data.matchLogs) data.matchLogs = {};
    if (!data.matchLogs[guildId]) data.matchLogs[guildId] = [];

    const logEntry = {
      matchId: match.id,
      type: match.type,
      winner: winnerId,
      opponents: loserIds,
      timestamp: Date.now(),
      scoreboard: match.scoreboardName || null,
    };

    data.matchLogs[guildId].unshift(logEntry);
    if (data.matchLogs[guildId].length > 100) data.matchLogs[guildId] = data.matchLogs[guildId].slice(0, 100);
    db.set(data);

    // Post to match log channel if set
    const settings = data.settings[guildId] || {};
    if (settings.logChannelId) {
      const ch = await client.channels.fetch(settings.logChannelId);
      const embed = new EmbedBuilder()
        .setTitle('📋 Match Result')
        .setColor(0x00c853)
        .addFields(
          { name: '🏆 Winner', value: `<@${winnerId}>`, inline: true },
          { name: '❌ Opponents', value: loserIds.map(id => `<@${id}>`).join(', '), inline: true },
          { name: '🎮 Type', value: match.type.toUpperCase(), inline: true },
          { name: '📊 Scoreboard', value: match.scoreboardName || 'None', inline: true },
        )
        .setTimestamp();
      await ch.send({ embeds: [embed] });
    }
  } catch (e) {
    console.error('Failed to log match result:', e.message);
  }
}

async function startBracket(client, matchId) {
  const data = db.get();
  const match = data.matches[matchId];
  if (!match || match.status !== 'queuing') return;

  const minPlayers = match.type === '1v1' ? 4 : 6;
  if (match.queue.length < minPlayers) {
    try {
      const channel = await client.channels.fetch(match.channelId);
      const msg = await channel.messages.fetch(match.messageId);
      await msg.edit({
        embeds: [new EmbedBuilder().setTitle('❌ Match Cancelled').setColor(0xff0000)
          .setDescription(`Not enough players. Need **${minPlayers}**, only **${match.queue.length}** joined.`)],
        components: []
      });
    } catch {}
    delete data.matches[matchId];
    db.set(data);
    return;
  }

  match.status = 'bracket';
  match.bracket = generateBracket(match.queue);
  match.currentRound = 0;

  // Fetch display names
  try {
    const guild = await client.guilds.fetch(match.guildId);
    for (const round of match.bracket) {
      for (const m of round) {
        if (m.p1) { try { const mem = await guild.members.fetch(m.p1); m.p1Tag = mem.displayName; } catch {} }
        if (m.p2) { try { const mem = await guild.members.fetch(m.p2); m.p2Tag = mem.displayName; } catch {} }
      }
    }
  } catch {}

  data.matches[matchId] = match;
  db.set(data);

  // Create private channel
  const privateChannel = await createMatchChannel(client, match);
  if (privateChannel) {
    match.privateChannelId = privateChannel.id;
    data.matches[matchId] = match;
    db.set(data);

    const components = buildBracketComponents(match, 0);
    const bracketMsg = await privateChannel.send({
      content: `🏁 Match starting! Players: ${match.queue.map(id => `<@${id}>`).join(', ')}`,
      embeds: [buildBracketEmbed(match, 0)],
      components
    });

    match.bracketMessageId = bracketMsg.id;
    data.matches[matchId] = match;
    db.set(data);
  }

  // Update original queue message
  try {
    const channel = await client.channels.fetch(match.channelId);
    const msg = await channel.messages.fetch(match.messageId);
    await msg.edit({
      embeds: [new EmbedBuilder()
        .setTitle('⚔️ Match Started!')
        .setColor(DARK_BLUE)
        .setDescription(`**${match.queue.length} players** locked in. Check your private match channel!`)
        .setTimestamp()],
      components: []
    });
  } catch {}
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('creatematch')
    .setDescription('Create a match queue')
    .addStringOption(o =>
      o.setName('type').setDescription('Match type').setRequired(true)
        .addChoices({ name: '1v1', value: '1v1' }, { name: '2v2', value: '2v2' })
    )
    .addStringOption(o =>
      o.setName('scoreboard').setDescription('Scoreboard to credit wins to').setRequired(false).setAutocomplete(true)
    ),

  async autocomplete(interaction) {
    const data = db.get();
    const boards = Object.values(data.scoreboards || {}).filter(s => s.guildId === interaction.guildId);
    const focused = interaction.options.getFocused().toLowerCase();
    const choices = boards
      .filter(s => s.name.toLowerCase().includes(focused))
      .slice(0, 25)
      .map(s => ({ name: s.name, value: s.name }));
    await interaction.respond(choices);
  },

  async execute(interaction) {
    if (!canManageMatch(interaction.member)) {
      return interaction.reply({ content: '❌ You do not have permission to create matches.', ephemeral: true });
    }

    const type = interaction.options.getString('type');
    const sbName = interaction.options.getString('scoreboard');
    const matchId = `match-${interaction.guildId}-${Date.now()}`;
    const endsAt = Date.now() + QUEUE_DURATION_MS;
    const minPlayers = type === '1v1' ? 4 : 6;

    const match = {
      id: matchId,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      type,
      scoreboardName: sbName || null,
      queue: [],
      status: 'queuing',
      endsAt,
      bracket: [],
      currentRound: 0,
      messageId: null,
      privateChannelId: null,
      bracketMessageId: null,
      hostId: interaction.user.id,
    };

    const joinRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`join_queue_${matchId}`).setLabel('Join Queue').setStyle(ButtonStyle.Success).setEmoji('⚔️'),
      new ButtonBuilder().setCustomId(`leave_queue_${matchId}`).setLabel('Leave Queue').setStyle(ButtonStyle.Secondary).setEmoji('🚪'),
      new ButtonBuilder().setCustomId(`addminute_${matchId}`).setLabel('+1 Minute').setStyle(ButtonStyle.Secondary).setEmoji('⏱️'),
      new ButtonBuilder().setCustomId(`forcestart_${matchId}`).setLabel('Force Start').setStyle(ButtonStyle.Danger).setEmoji('🚀'),
    );

    const msg = await interaction.reply({
      embeds: [buildQueueEmbed(match)],
      components: [joinRow],
      fetchReply: true
    });

    match.messageId = msg.id;
    const data = db.get();
    if (!data.matches) data.matches = {};
    data.matches[matchId] = match;
    db.set(data);

    // Update timer every 30s
    const intervalId = setInterval(async () => {
      const fresh = db.get();
      const m = fresh.matches[matchId];
      if (!m || m.status !== 'queuing') { clearInterval(intervalId); return; }
      try {
        const ch = await interaction.client.channels.fetch(m.channelId);
        const ms = await ch.messages.fetch(m.messageId);
        await ms.edit({ embeds: [buildQueueEmbed(m)], components: [joinRow] });
      } catch {}
    }, 30000);

    const timer = setTimeout(async () => {
      clearInterval(intervalId);
      await startBracket(interaction.client, matchId);
    }, QUEUE_DURATION_MS);

    timers.set(matchId, { timer, interval: intervalId });
  },

  buildBracketEmbed,
  buildBracketComponents,
  buildQueueEmbed,
  startBracket,
  timers,
  canManageMatch,
  logMatchResult,
  MATCH_MANAGER_ROLES,
};
