import { EmbedBuilder } from 'discord.js';
import {
  isBoundedString,
  isDiscordSnowflake,
  toPositiveInteger,
} from '../../utils/boundaryValidators.js';
import {
  chunkDiscordMessage,
  formatMilitaryMultiline,
  formatNumber,
  invalid,
  parseDate,
  valid,
} from './support.js';
import { extractUserSnowflakes } from './runtime.js';

const isWarCounterSource = (source) => `${source?.type ?? ''}`.toLowerCase() === 'war_counter';

export const validate = (payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return invalid('invalid_payload');
  const forumId = payload.forum_channel_id ?? payload.channel_id;
  if (!forumId) return invalid('missing_channel');
  if (!isDiscordSnowflake(forumId)) return invalid('invalid_channel');
  if (
    payload.defense_role_id !== undefined &&
    payload.defense_role_id !== null &&
    !isDiscordSnowflake(payload.defense_role_id)
  ) return invalid('invalid_role');
  if (
    payload.source !== undefined &&
    (!payload.source || typeof payload.source !== 'object' || Array.isArray(payload.source))
  ) {
    return invalid('invalid_source');
  }
  if (isWarCounterSource(payload.source) && !toPositiveInteger(payload.source.id)) {
    return invalid('invalid_source_id');
  }
  if (payload.assigned_members !== undefined && !Array.isArray(payload.assigned_members)) {
    return invalid('invalid_assigned_members');
  }
  if (payload.room_name_suggestion !== undefined && !isBoundedString(payload.room_name_suggestion, {
    minLength: 1,
    maxLength: 100,
  })) {
    return invalid('invalid_room_name');
  }
  if (payload.reason !== undefined && !isBoundedString(payload.reason, { minLength: 1, maxLength: 1000 })) {
    return invalid('invalid_reason');
  }
  return valid();
};

export const execute = async (command, runtime) => {
  const payload = command.payload;
  const forumChannelId = `${payload.forum_channel_id ?? payload.channel_id}`.trim();
  const defenseRoleId = isDiscordSnowflake(payload.defense_role_id)
    ? `${payload.defense_role_id}`.trim()
    : null;
  const forum = await runtime.resolveChannel(forumChannelId);
  if (!forum?.isThreadOnly?.()) {
    runtime.logger.warn('WAR_ROOM_CREATE forum channel missing/inaccessible or not a forum', {
      channelId: forumChannelId,
      commandId: command?.id,
    });
    return { success: false, reason: 'channel_unavailable' };
  }

  const roomName = buildWarRoomName(payload);
  const participants = buildWarRoomParticipants(payload.assigned_members, payload.attacked_member);
  const mentionMessages = buildWarRoomMentionMessages(buildWarRoomMentions(participants));
  const assignmentMessages = buildWarRoomAssignmentMessages(payload);
  const attackedMention = buildWarRoomMemberMention(payload.attacked_member);
  const starterLines = buildWarRoomIntroLines(payload, attackedMention);

  try {
    let thread;
    const rawCheckpointChannelId = command?.result?.discord_channel_id;
    if (
      rawCheckpointChannelId !== undefined &&
      rawCheckpointChannelId !== null &&
      !isDiscordSnowflake(rawCheckpointChannelId)
    ) {
      runtime.logger.error('WAR_ROOM_CREATE contains an invalid persisted checkpoint', {
        commandId: command?.id,
      });
      return { success: false, reason: 'invalid_checkpoint' };
    }
    const checkpointChannelId = rawCheckpointChannelId?.trim() || null;

    if (checkpointChannelId) {
      const checkpointThread = await runtime.resolveChannel(checkpointChannelId);
      if (!checkpointThread?.isThread?.() || checkpointThread.parentId !== forum.id) {
        runtime.logger.error('WAR_ROOM_CREATE checkpoint does not resolve to the configured forum', {
          commandId: command?.id,
          checkpointChannelId,
          expectedForumId: forum.id,
          actualParentId: checkpointThread?.parentId ?? null,
        });
        return { success: false, reason: 'invalid_checkpoint' };
      }
      thread = checkpointThread;
    } else {
      if (!runtime.canContinue()) return { success: false, reason: 'lease_lost' };
      thread = await runtime.createForumThread(
        forum,
        command,
        'war-room-starter',
        {
          name: roomName,
          message: {
            content: starterLines.join('\n'),
            embeds: [buildWarRoomEmbed(command)],
            allowedMentions: { users: extractUserSnowflakes(starterLines.join('\n')) },
          },
        },
        `create WAR_ROOM_CREATE forum thread ${roomName}`,
      );

      if (!isDiscordSnowflake(thread?.id)) {
        runtime.logger.error('WAR_ROOM_CREATE returned an invalid Discord thread id', {
          commandId: command?.id,
          reconciliationRequired: true,
        });
        return { success: false, reason: 'invalid_thread' };
      }
      if (!runtime.apiService?.checkpointDiscordQueue || !command?.lease_token) {
        runtime.logger.error('WAR_ROOM_CREATE thread requires a durable queue checkpoint', {
          commandId: command?.id,
          threadId: thread.id,
          reconciliationRequired: true,
        });
        return { success: false, reason: 'checkpoint_unavailable' };
      }
      try {
        await runtime.apiService.checkpointDiscordQueue(command.id, command.lease_token, {
          discord_channel_id: thread.id,
        });
      } catch (error) {
        runtime.logger.error('WAR_ROOM_CREATE thread was created but checkpoint failed', {
          commandId: command?.id,
          threadId: thread.id,
          reconciliationRequired: true,
          status: error?.response?.status ?? null,
        });
        return { success: false, reason: 'checkpoint_failed' };
      }
    }

    if (isWarCounterSource(payload.source)) {
      if (!runtime.canContinue()) return { success: false, reason: 'lease_lost' };
      if (!await attachWarCounterChannel(runtime, payload.source.id, thread.id, command?.id)) {
        return { success: false, reason: 'counter_attach_failed' };
      }
    }

    if (isWarCounterSource(payload.source) && defenseRoleId) {
      if (!runtime.canContinue()) return { success: false, reason: 'lease_lost' };
      await runtime.send(
        thread,
        command,
        'defense-role-ping',
        { content: `<@&${defenseRoleId}>`, allowedMentions: { roles: [defenseRoleId] } },
        'send WAR_ROOM_CREATE defense role ping',
      );
    }

    for (const [index, content] of mentionMessages.entries()) {
      if (!runtime.canContinue()) return { success: false, reason: 'lease_lost' };
      await runtime.send(
        thread,
        command,
        `mention-${index}`,
        { content, allowedMentions: { users: extractUserSnowflakes(content) } },
        'send WAR_ROOM_CREATE mention message',
      );
    }

    for (const [index, content] of assignmentMessages.entries()) {
      if (!runtime.canContinue()) return { success: false, reason: 'lease_lost' };
      await runtime.send(
        thread,
        command,
        `assignment-${index}`,
        { content },
        'send WAR_ROOM_CREATE assignment message',
      );
    }

    runtime.logger.info('Delivered WAR_ROOM_CREATE thread', {
      commandId: command?.id,
      forumChannelId,
      threadId: thread.id,
      targetNationId: payload?.target?.id ?? null,
      assignedCount: Array.isArray(payload.assigned_members) ? payload.assigned_members.length : 0,
    });
    return { success: true };
  } catch (error) {
    runtime.logger.error('Failed to create/send WAR_ROOM_CREATE thread in Discord', error?.message ?? error);
    return { success: false, reason: 'discord_send_failed' };
  }
};

async function attachWarCounterChannel(runtime, warCounterId, discordChannelId, commandId) {
  const normalizedCounterId = toPositiveInteger(warCounterId);
  if (!normalizedCounterId || !isDiscordSnowflake(discordChannelId) || !runtime.apiService?.attachWarCounterChannel) {
    runtime.logger.warn('ApiService or valid ids unavailable; cannot attach war-counter channel', {
      commandId,
      warCounterId,
      discordChannelId,
    });
    return false;
  }
  try {
    await runtime.apiService.attachWarCounterChannel({
      war_counter_id: normalizedCounterId,
      discord_channel_id: discordChannelId,
    });
    runtime.logger.info('Attached war-counter channel to Nexus', {
      commandId,
      warCounterId: normalizedCounterId,
      discordChannelId,
    });
    return true;
  } catch (error) {
    runtime.logger.warn('Failed attaching war-counter channel to Nexus', {
      commandId,
      warCounterId: normalizedCounterId,
      discordChannelId,
      error: error?.message ?? error,
    });
    return false;
  }
}

function buildWarRoomName(payload) {
  const suggested = typeof payload.room_name_suggestion === 'string' && payload.room_name_suggestion.trim()
    ? payload.room_name_suggestion.trim()
    : null;
  if (suggested) return suggested.slice(0, 100);

  const leader = payload?.target?.leader_name ?? null;
  const sourceType = payload?.source?.type ?? 'war';
  const sourceId = payload?.source?.id ?? null;
  const base = `${sourceType}-${sourceId ?? 'target'}-${leader ?? payload?.target?.id ?? 'room'}`
    .toLowerCase()
    .replace(/[^a-z0-9-_ ]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
  return (base || `war-room-${Date.now()}`).slice(0, 100);
}

function buildWarRoomMemberMention(member) {
  if (!member || typeof member !== 'object') return null;
  const mentionId = `${member?.mention ?? ''}`.match(/^<@(\d{17,20})>$/)?.[1];
  const discordId = isDiscordSnowflake(member?.discord_id) ? `${member.discord_id}`.trim() : null;
  const normalized = mentionId && isDiscordSnowflake(mentionId) ? mentionId : discordId;
  return normalized ? `<@${normalized}>` : null;
}

function buildWarRoomParticipants(assignedMembers, attackedMember) {
  const participants = [];
  if (attackedMember && typeof attackedMember === 'object') participants.push(attackedMember);
  if (Array.isArray(assignedMembers)) participants.push(...assignedMembers);

  const unique = new Map();
  for (const member of participants) {
    if (!member || typeof member !== 'object') continue;
    const key = member?.nation_id !== undefined && member?.nation_id !== null
      ? `nation:${member.nation_id}`
      : null;
    if (key) {
      const existing = unique.get(key);
      if (!existing || (!buildWarRoomMemberMention(existing) && buildWarRoomMemberMention(member))) {
        unique.set(key, member);
      }
      continue;
    }
    const fallback = buildWarRoomMemberMention(member) ?? member?.nation_name ?? member?.leader_name ?? null;
    if (fallback && !unique.has(`fallback:${fallback}`)) unique.set(`fallback:${fallback}`, member);
  }
  return Array.from(unique.values());
}

function buildWarRoomMentions(members) {
  const mentions = new Set();
  for (const member of Array.isArray(members) ? members : []) {
    const mention = buildWarRoomMemberMention(member);
    if (mention) mentions.add(mention);
  }
  return Array.from(mentions);
}

function buildWarRoomIntroLines(payload, attackedMention) {
  const target = payload.target ?? {};
  const lines = [
    '## War Room Opened',
    `Target: ${target.nation_name ?? 'Unknown nation'} (${target.leader_name ?? 'Unknown leader'})`,
    'Target briefing below. Assignments and pings follow.',
  ];
  if (payload.attacked_member) {
    lines.splice(2, 0, `Defender: ${attackedMention ?? payload.attacked_member.nation_name ?? 'Unknown nation'}`);
  }
  return lines;
}

function buildWarRoomEmbed(command) {
  const payload = command.payload;
  const target = payload.target ?? {};
  const links = payload.links ?? {};
  const createdAt = parseDate(command?.created_at) ?? new Date();
  const attackType = payload?.attack_type?.label ?? payload?.attack_type?.key ?? 'Unspecified';
  const sourceType = payload?.source?.type ?? 'war_plan';
  const sourceId = payload?.source?.id ?? null;
  const sourceLabel = sourceId ? `${sourceType} #${sourceId}` : sourceType;
  const sourceLink = payload?.source?.url ? `[${sourceLabel}](${payload.source.url})` : sourceLabel;
  const nationName = target.nation_name ?? 'Unknown nation';
  const nationLink = links.target_nation ? `[${nationName}](${links.target_nation})` : nationName;
  const objectives = [];
  if (links.declare_war) objectives.push(`⚔️ [Declare War](${links.declare_war})`);
  if (links.war_simulators) objectives.push(`🧪 [War Simulators](${links.war_simulators})`);
  if (payload.source?.url) objectives.push(`🧭 [Source Plan](${payload.source.url})`);

  const embed = new EmbedBuilder()
    .setTitle(`⚔️ Target Brief: ${target.leader_name ?? 'Unknown leader'}`)
    .setColor(0xb02e26)
    .setDescription([
      `**Target:** ${nationLink} (${target.leader_name ?? 'Unknown leader'})`,
      `**Attack Type:** ${attackType}`,
      `**Source:** ${sourceLink}`,
      objectives.length ? `\n${objectives.join(' • ')}` : '',
    ].filter(Boolean).join('\n'))
    .addFields(
      { name: 'Alliance', value: formatAlliance(target.alliance), inline: true },
      { name: 'Score / Cities', value: `${formatNumber(target.score)} / ${formatNumber(target.cities)}`, inline: true },
      {
        name: 'War Loadout',
        value: `Off: ${formatNumber(target.offensive_wars)} | Def: ${formatNumber(target.defensive_wars)} | Beige Turns: ${formatNumber(target.beige_turns)}`,
        inline: true,
      },
      { name: 'Military Snapshot', value: formatMilitaryMultiline(target.military) },
    )
    .setFooter({ text: 'Nexus AMS War Room' })
    .setTimestamp(createdAt);
  if (links.target_nation) embed.setURL(links.target_nation);
  return embed;
}

function formatAlliance(alliance = {}) {
  return `${alliance?.name ?? 'No alliance'}${alliance?.acronym ? ` (${alliance.acronym})` : ''}`;
}

function formatMemberLine(member, index) {
  const nationName = member?.nation_name ?? 'Unknown nation';
  const nation = member?.links?.nation ? `[${nationName}](${member.links.nation})` : nationName;
  return `${index + 1}. ${buildWarRoomMemberMention(member) ?? 'No Discord link'} | ${nation} (${member?.leader_name ?? 'Unknown leader'}) | Match: ${formatNumber(member?.match_score)} | Score: ${formatNumber(member?.score)} | Cities: ${formatNumber(member?.cities)} | Role: ${member?.role ?? 'counter'} | Wars O/D: ${formatNumber(member?.offensive_wars)}/${formatNumber(member?.defensive_wars)}`;
}

function buildWarRoomAssignmentMessages(payload) {
  const assigned = Array.isArray(payload.assigned_members) ? payload.assigned_members : [];
  const counters = assigned.filter((member) => `${member?.role ?? 'counter'}` !== 'defender');
  const defenders = buildWarRoomParticipants(
    assigned.filter((member) => `${member?.role ?? 'counter'}` === 'defender'),
    payload.attacked_member,
  );
  const reason = typeof payload.reason === 'string' && payload.reason.trim() ? payload.reason.trim() : 'Unspecified';
  return chunkDiscordMessage([
    '### Friendly Assignments',
    ...(counters.length ? counters.map(formatMemberLine) : ['No assigned friendly nations were provided for this target.']),
    '',
    '### Defending Nation',
    ...(defenders.length ? defenders.map(formatMemberLine) : ['No defending nation was provided for this target.']),
    '',
    '### War Instructions',
    `Attack Type: ${payload?.attack_type?.label ?? payload?.attack_type?.key ?? 'Unspecified'}`,
    `Reason: ${reason}`,
  ].join('\n'));
}

function buildWarRoomMentionMessages(mentions) {
  if (!mentions.length) return ['### Assigned Friendlies\nNo Discord mentions available for this target.'];
  const messages = [];
  let current = '### Assigned Friendlies\n';
  for (const mention of mentions) {
    const token = `${mention} `;
    if ((current + token).length <= 1900) {
      current += token;
    } else {
      messages.push(current.trimEnd());
      current = `### Assigned Friendlies\n${token}`;
    }
  }
  if (current.trim()) messages.push(current.trimEnd());
  return messages;
}
