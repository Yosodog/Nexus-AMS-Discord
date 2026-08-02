import {
  isBoundedString,
  isDiscordSnowflake,
  toPositiveInteger,
} from '../../utils/boundaryValidators.js';
import {
  buildEmbed,
  escapeMarkdown,
  markdownLink,
  safeUrl,
  truncate,
} from '../../utils/discordUi.js';
import {
  formatNumber,
  invalid,
  parseDate,
  valid,
} from './support.js';
import { extractUserSnowflakes } from './runtime.js';

const isWarCounterSource = (source) => `${source?.type ?? ''}`.toLowerCase() === 'war_counter';
const MAX_RENDERED_ASSIGNED_MEMBERS = 25;
const MAX_OUTPUT_URL_LENGTH = 512;
const PAGINATED_BODY_LIMIT = 1700;

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
  const assignmentRoster = selectAssignedMembers(payload.assigned_members);
  const participants = buildWarRoomParticipants(payload.assigned_members, payload.attacked_member);
  const mentionMessages = buildWarRoomMentionMessages(buildWarRoomMentions(participants));
  const assignmentMessages = buildWarRoomAssignmentMessages(payload, assignmentRoster);
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
      // Preserve this dedicated durable send; the assignment messages provide its surrounding context.
      await runtime.send(
        thread,
        command,
        'defense-role-ping',
        {
          content: `## Defense Team\n<@&${defenseRoleId}> — a new war room needs your attention. Assignment details follow below.`,
          allowedMentions: { roles: [defenseRoleId] },
        },
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
  const suggested = typeof payload.room_name_suggestion === 'string'
    ? normalizeSingleLine(payload.room_name_suggestion, '', 100)
    : '';
  if (suggested) return suggested;

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

function selectAssignedMembers(assignedMembers) {
  const entries = Array.isArray(assignedMembers) ? assignedMembers : [];
  const members = entries
    .slice(0, MAX_RENDERED_ASSIGNED_MEMBERS)
    .filter((member) => member && typeof member === 'object' && !Array.isArray(member));
  return {
    members,
    omittedCount: Math.max(0, entries.length - members.length),
    totalCount: entries.length,
  };
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
  const lines = ['## War Room Opened'];
  if (payload.attacked_member) {
    const defender = payload.attacked_member;
    const nation = linkedDisplayText(
      defender?.nation_name,
      'Unknown nation',
      defender?.links?.nation,
      120,
    );
    const leader = escapedDisplayText(defender?.leader_name, 'Unknown leader', 120);
    const identity = attackedMention ? `${attackedMention} — ${nation}` : nation;
    lines.push(`**Defending member:** ${identity} (${leader})`);
  }
  lines.push('Target brief is below. Participant notifications and assignment details follow.');
  return lines;
}

function buildWarRoomEmbed(command) {
  const payload = command.payload;
  const target = payload.target ?? {};
  const links = payload.links ?? {};
  const createdAt = parseDate(command?.created_at) ?? new Date();
  const attackType = escapedDisplayText(
    payload?.attack_type?.label ?? payload?.attack_type?.key,
    'Unspecified',
    80,
  );
  const reason = escapedDisplayText(payload.reason, 'Unspecified', 300);
  const sourceType = normalizeSingleLine(payload?.source?.type, 'war plan', 80);
  const sourceId = payload?.source?.id ?? null;
  const sourceLabel = sourceId
    ? `${sourceType.replace(/[_-]+/g, ' ')} #${normalizeSingleLine(sourceId, 'unknown', 40)}`
    : sourceType.replace(/[_-]+/g, ' ');
  const escapedSourceLabel = escapedDisplayText(sourceLabel, 'War plan', 120);
  const nationName = normalizeSingleLine(target.nation_name, 'Unknown nation', 120);
  const leaderName = escapedDisplayText(target.leader_name, 'Unknown leader', 120);
  const nationProfile = safeOutputUrl(links.target_nation, 2048);
  const nationLink = markdownLink(nationName, nationProfile);
  const actionLinks = [
    ['Declare war', links.declare_war],
    ['War simulators', links.war_simulators],
    ['Source plan', payload?.source?.url],
  ].flatMap(([label, url]) => {
    const href = safeOutputUrl(url);
    return href ? [markdownLink(label, href)] : [];
  });

  return buildEmbed({
    title: `⚔️ Target Brief — ${escapedDisplayText(nationName, 'Unknown nation', 120)}`,
    color: 0xb02e26,
    description: `**${nationLink}** — ${leaderName}`,
    fields: [
      {
        name: 'Objective',
        value: [
          `**Attack type:** ${attackType}`,
          `**Reason:** ${reason}`,
          `**Source:** ${escapedSourceLabel}`,
        ].join('\n'),
      },
      {
        name: 'Target status',
        value: [
          formatAlliance(target.alliance, links.target_alliance),
          `${formatNumber(target.score)} score · ${formatNumber(target.cities)} cities`,
          `Wars: ${formatNumber(target.offensive_wars)} offensive · ${formatNumber(target.defensive_wars)} defensive · Beige: ${formatNumber(target.beige_turns)} turns`,
        ].join('\n'),
      },
      { name: 'Military', value: formatMilitaryBrief(target.military) },
      actionLinks.length ? { name: 'Links', value: actionLinks.join(' · ') } : null,
    ],
    url: nationProfile,
  }).setTimestamp(createdAt);
}

function formatAlliance(alliance = {}, url = null) {
  const name = normalizeSingleLine(alliance?.name, 'No alliance', 120);
  const acronym = alliance?.acronym
    ? normalizeSingleLine(alliance.acronym, '', 24)
    : '';
  const label = acronym ? `${name} (${acronym})` : name;
  return markdownLink(label, safeOutputUrl(url ?? alliance?.url ?? alliance?.link));
}

function formatMilitaryBrief(military = {}) {
  return [
    `Soldiers ${formatNumber(military?.soldiers)} · Tanks ${formatNumber(military?.tanks)} · Aircraft ${formatNumber(military?.aircraft)} · Ships ${formatNumber(military?.ships)}`,
    `Spies ${formatNumber(military?.spies)} · Missiles ${formatNumber(military?.missiles)} · Nukes ${formatNumber(military?.nukes)}`,
  ].join('\n');
}

function formatMemberBlock(member, index, roleFallback = 'Counter') {
  const nation = linkedDisplayText(member?.nation_name, 'Unknown nation', member?.links?.nation, 120);
  const leader = escapedDisplayText(member?.leader_name, 'Unknown leader', 120);
  const role = formatRoleLabel(member?.role, roleFallback);
  return [
    `**${index + 1}. ${nation}** — ${leader}`,
    `${buildWarRoomMemberMention(member) ?? 'No Discord mention'} · ${role}`,
    `Match ${formatNumber(member?.match_score)} · ${formatNumber(member?.score)} score · ${formatNumber(member?.cities)} cities · Wars ${formatNumber(member?.offensive_wars)}/${formatNumber(member?.defensive_wars)}`,
  ].join('\n');
}

function buildWarRoomAssignmentMessages(payload, roster = selectAssignedMembers(payload.assigned_members)) {
  const assigned = roster.members;
  const counters = assigned.filter((member) => memberRoleKey(member) !== 'defender');
  const defenders = buildWarRoomParticipants(
    assigned.filter((member) => memberRoleKey(member) === 'defender'),
    payload.attacked_member,
  );
  const attackType = escapedDisplayText(
    payload?.attack_type?.label ?? payload?.attack_type?.key,
    'Unspecified',
    120,
  );
  const reason = escapedDisplayText(payload.reason, 'Unspecified', 700);
  const sourcePlan = safeOutputUrl(payload?.source?.url);
  const groups = [
    {
      title: 'Counters',
      blocks: counters.length
        ? counters.map((member, index) => formatMemberBlock(member, index, 'Counter'))
        : ['No counter assignments were provided for this target.'],
    },
    {
      title: 'Defender',
      blocks: defenders.length
        ? defenders.map((member, index) => formatMemberBlock(member, index, 'Defender'))
        : ['No defending nation was provided for this target.'],
    },
  ];

  if (roster.omittedCount > 0) {
    groups.push({
      title: 'Roster limit',
      blocks: [[
        `To keep this war room readable, ${formatNumber(roster.omittedCount)} additional assignment ${roster.omittedCount === 1 ? 'entry was' : 'entries were'} omitted from the Discord summary.`,
        sourcePlan ? markdownLink('Open the source plan for the complete roster', sourcePlan) : null,
      ].filter(Boolean).join('\n')],
    });
  }

  groups.push({
    title: 'Instructions',
    blocks: [[
      `**Attack type:** ${attackType}`,
      `**Reason:** ${reason}`,
    ].join('\n')],
  });

  return paginateSectionedBlocks('Assignments', groups);
}

function buildWarRoomMentionMessages(mentions) {
  if (!mentions.length) {
    return [[
      '## Participant Notifications',
      '',
      'No linked Discord accounts were available for the defender or assigned nations. Assignment details follow.',
    ].join('\n')];
  }

  const bodyPrefix = 'The following linked participants are being notified about this war room:';
  const bodySuffix = 'Assignment details follow in a separate message.';
  const pages = [];
  let current = [];
  for (const mention of mentions) {
    const candidate = [...current, mention];
    const body = [bodyPrefix, '', candidate.join(' '), '', bodySuffix].join('\n');
    if (body.length <= PAGINATED_BODY_LIMIT) {
      current = candidate;
      continue;
    }
    if (current.length) pages.push(current);
    current = [mention];
  }
  if (current.length) pages.push(current);

  return pages.map((page, index) => [
    `## Participant Notifications — Part ${index + 1} of ${pages.length}`,
    '',
    bodyPrefix,
    '',
    page.join(' '),
    '',
    bodySuffix,
  ].join('\n'));
}

function paginateSectionedBlocks(title, groups) {
  const pages = [];
  let current = '';
  let currentSections = new Set();

  for (const group of groups) {
    for (const block of group.blocks) {
      const needsHeading = !currentSections.has(group.title);
      const segment = `${needsHeading ? `### ${group.title}\n` : ''}${block}`;
      const candidate = current ? `${current}\n\n${segment}` : segment;

      if (candidate.length <= PAGINATED_BODY_LIMIT) {
        current = candidate;
        currentSections.add(group.title);
        continue;
      }

      if (current) pages.push(current);
      current = `### ${group.title}\n${block}`;
      currentSections = new Set([group.title]);
    }
  }

  if (current) pages.push(current);
  return pages.map((body, index) => [
    `## ${title} — Part ${index + 1} of ${pages.length}`,
    '',
    body,
  ].join('\n'));
}

function memberRoleKey(member) {
  return normalizeSingleLine(member?.role, 'counter', 60).toLowerCase();
}

function formatRoleLabel(value, fallback) {
  const normalized = normalizeSingleLine(value, fallback, 60).replace(/[_-]+/g, ' ');
  const label = normalized.replace(/\b\w/g, (character) => character.toUpperCase());
  return escapeMarkdown(label);
}

function linkedDisplayText(value, fallback, url, maxLength) {
  return markdownLink(
    normalizeSingleLine(value, fallback, maxLength),
    safeOutputUrl(url),
  );
}

function escapedDisplayText(value, fallback, maxLength) {
  return escapeMarkdown(normalizeSingleLine(value, fallback, maxLength));
}

function normalizeSingleLine(value, fallback, maxLength) {
  const normalized = value === undefined || value === null
    ? ''
    : String(value)
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const result = normalized || fallback;
  return result ? truncate(result, maxLength, '') : '';
}

function safeOutputUrl(value, maxLength = MAX_OUTPUT_URL_LENGTH) {
  const href = safeUrl(value);
  return href && href.length <= maxLength ? href : null;
}
