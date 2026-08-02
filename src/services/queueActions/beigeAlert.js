import { isDiscordSnowflake } from '../../utils/boundaryValidators.js';
import {
  buildEmbed,
  escapeMarkdown,
  markdownLink,
  safeUrl,
} from '../../utils/discordUi.js';

export const validate = (payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, reason: 'invalid_payload' };
  }

  if (payload.channel_id === undefined || payload.channel_id === null) {
    return { valid: false, reason: 'missing_channel' };
  }

  if (typeof payload.channel_id !== 'string') {
    return { valid: false, reason: 'invalid_channel' };
  }

  const channelId = payload.channel_id.trim();
  if (!channelId) return { valid: false, reason: 'missing_channel' };

  if (!isDiscordSnowflake(channelId)) {
    return { valid: false, reason: 'invalid_channel' };
  }

  const hasNationList = Array.isArray(payload.nations) && payload.nations.length > 0;
  const hasNation =
    payload.nation && typeof payload.nation === 'object' && !Array.isArray(payload.nation);

  if (!hasNationList && !hasNation) {
    return { valid: false, reason: 'invalid_payload' };
  }

  return { valid: true };
};

export const execute = async (command, context) => {
  const payload = command?.payload;
  const validation = validate(payload);

  if (!validation.valid) {
    if (validation.reason === 'missing_channel') {
      context.logger.warn('BEIGE_ALERT payload missing channel_id', command?.id ?? 'unknown');
    } else if (validation.reason === 'invalid_channel') {
      context.logger.warn('BEIGE_ALERT payload has invalid channel_id', command?.id ?? 'unknown');
    } else {
      context.logger.warn('BEIGE_ALERT payload missing nation/nations data', command?.id ?? 'unknown');
    }
    return { success: false, reason: validation.reason };
  }

  const channelId = payload.channel_id.trim();
  const channel = await context.resolveTextChannel(channelId);

  if (!channel) {
    context.logger.warn('BEIGE_ALERT channel missing or inaccessible', {
      channelId,
      commandId: command?.id,
    });
    return { success: false, reason: 'channel_unavailable' };
  }

  try {
    if (Array.isArray(payload.nations) && payload.nations.length > 0) {
      const messages = buildBeigeTurnMessages(command);

      for (const [index, content] of messages.entries()) {
        if (context.canContinue && !context.canContinue()) {
          return { success: false, reason: 'lease_lost' };
        }
        await context.send(
          channel,
          command,
          `beige-turn-${index}`,
          { content },
          'send BEIGE_ALERT turn-summary message',
        );
      }

      context.logger.info('Delivered BEIGE_ALERT turn-summary messages', {
        commandId: command?.id,
        channelId,
        messagesSent: messages.length,
        nationCount: payload.nations.length,
      });

      return { success: true };
    }

    if (payload.nation && typeof payload.nation === 'object' && !Array.isArray(payload.nation)) {
      if (!context.canContinue()) return { success: false, reason: 'lease_lost' };
      const embed = buildBeigeExitEmbed(command);
      await context.send(
        channel,
        command,
        'beige-exit',
        { embeds: [embed] },
        'send BEIGE_ALERT single-exit embed',
      );

      context.logger.info('Delivered BEIGE_ALERT single-exit embed', {
        commandId: command?.id,
        channelId,
        eventType: payload.event_type ?? null,
      });

      return { success: true };
    }

    context.logger.warn('BEIGE_ALERT payload missing nation/nations data', command?.id ?? 'unknown');
    return { success: false, reason: 'invalid_payload' };
  } catch (error) {
    context.logger.error('Failed to send BEIGE_ALERT message to Discord', error?.message ?? error);
    return { success: false, reason: 'discord_send_failed' };
  }
};

function buildBeigeTurnMessages(command) {
  const payload = command?.payload ?? {};
  const nations = Array.isArray(payload.nations) ? payload.nations : [];
  const turnTime = parseDate(payload.turn_change_at);
  const createdAt = parseDate(command?.created_at);

  const eventLabel = describeBeigeEvent(payload.event_type, payload.window);
  const count = payload.nation_count ?? nations.length;
  const blocks = nations.map((nation, index) => formatBeigeNationBlock(nation, index));

  return paginateDiscordBlocks(
    blocks,
    (part, totalParts) => buildBeigeTurnHeader({
      eventLabel,
      count,
      turnTime,
      createdAt,
      part,
      totalParts,
    }),
  );
}

function buildBeigeExitEmbed(command) {
  const payload = command?.payload ?? {};
  const nation = payload.nation ?? {};
  const createdAt = parseDate(command?.created_at) ?? new Date();
  const detectedAt = parseDate(payload.detected_at) ?? createdAt;
  const nationLabel = formatLabel(nation.nation_name, 'Unknown nation', 80);
  const leader = formatLabel(nation.leader_name, 'Unknown leader', 80);
  const declareWarUrl = buildDeclareWarUrl(nation.id);
  const nationLink = formatSafeUrl(nation.links?.nation);
  const description = [
    `**${escapeMarkdown(leader)}** is no longer protected by beige (${formatDiscordTime(detectedAt, 'R')}).`,
    declareWarUrl ? formatSafeMarkdownLink('Declare war', declareWarUrl) : null,
  ].filter(Boolean).join('\n');

  return buildEmbed({
    title: `🟨 Beige Exit — ${escapeMarkdown(nationLabel)}`,
    color: 0xd4b06a,
    description,
    url: nationLink,
    fields: [
      {
        name: 'Alliance',
        value: formatAllianceWithLink(nation),
        inline: true,
      },
      {
        name: 'Score',
        value: formatNumber(nation.score),
        inline: true,
      },
      {
        name: 'Cities',
        value: formatNumber(nation.cities, 0),
        inline: true,
      },
      {
        name: 'Previous beige',
        value: formatCount(payload.previous_beige_turns ?? 0, 'turn', 'turns'),
        inline: true,
      },
      {
        name: 'Military',
        value: formatMilitaryCompact(nation.military),
      },
    ],
  }).setTimestamp(detectedAt);
}

function formatAllianceWithLink(nation = {}) {
  const alliance = nation.alliance ?? {};
  const name = formatLabel(alliance.name, 'No alliance', 80);
  const link = nation.links?.alliance ?? null;

  return formatSafeMarkdownLink(name, link);
}

function formatMilitaryCompact(military = {}) {
  return [
    `Soldiers ${formatNumber(military.soldiers, 0)} · Tanks ${formatNumber(military.tanks, 0)} · Aircraft ${formatNumber(military.aircraft, 0)} · Ships ${formatNumber(military.ships, 0)}`,
    `Spies ${formatNumber(military.spies, 0)} · Missiles ${formatNumber(military.missiles, 0)} · Nukes ${formatNumber(military.nukes, 0)}`,
  ].join('\n');
}

function formatBeigeNationBlock(nation = {}, index) {
  const nationName = formatLabel(nation.nation_name, 'Unknown nation', 80);
  const leader = formatLabel(nation.leader_name, 'Unknown leader', 80);
  const allianceName = formatLabel(nation.alliance?.name, 'No alliance', 80);
  const nationLabel = formatSafeMarkdownLink(nationName, nation.links?.nation);
  const allianceLabel = formatSafeMarkdownLink(allianceName, nation.links?.alliance);
  const declareWarUrl = buildDeclareWarUrl(nation.id);

  return [
    `### ${index + 1}. ${nationLabel} — ${escapeMarkdown(leader)}`,
    `**Alliance:** ${allianceLabel}`,
    `**Status:** ${formatCount(nation.cities, 'city', 'cities')} · ${formatNumber(nation.score)} score · ${formatCount(nation.beige_turns, 'beige turn', 'beige turns')}`,
    `**Military:** ${formatMilitaryCompact(nation.military)}`,
    declareWarUrl ? formatSafeMarkdownLink('Declare war', declareWarUrl) : null,
  ].filter(Boolean).join('\n');
}

function buildBeigeTurnHeader({
  eventLabel,
  count,
  turnTime,
  createdAt,
  part,
  totalParts,
}) {
  const context = [];

  if (turnTime) {
    context.push(`**Turn:** ${formatDiscordTime(turnTime, 'f')} (${formatDiscordTime(turnTime, 'R')})`);
  } else if (createdAt) {
    context.push(`**Updated:** ${formatDiscordTime(createdAt, 'R')}`);
  }

  context.push(`**Nations:** ${formatNumber(count, 0)}`);
  context.push(`**Part:** ${part} of ${totalParts}`);

  return `## 🟨 Beige Watch — ${eventLabel}\n${context.join(' · ')}`;
}

function describeBeigeEvent(eventType, window) {
  if (eventType === 'upcoming_turn_exit') {
    return 'Expected to Leave Beige This Turn';
  }

  if (eventType === 'turn_exit') {
    return 'Left Beige This Turn';
  }

  if (eventType === 'early_exit') {
    return 'Early Beige Exits';
  }

  if (window === 'pre_turn' || window === 'upcoming') {
    return 'Expected to Leave Beige This Turn';
  }

  if (window === 'post_turn') {
    return 'Post-Turn Beige Status';
  }

  return 'Beige Status Update';
}

function paginateDiscordBlocks(blocks, buildHeader, maxLength = 2000) {
  let expectedParts = 1;

  while (true) {
    const pages = [[]];

    for (const block of blocks) {
      const currentPage = pages.at(-1);
      const part = pages.length;
      const candidate = composeDiscordPage(buildHeader(part, expectedParts), [
        ...currentPage,
        block,
      ]);

      if (candidate.length <= maxLength) {
        currentPage.push(block);
        continue;
      }

      const nextPart = pages.length + 1;
      const singleBlockPage = composeDiscordPage(buildHeader(nextPart, expectedParts), [block]);

      if (singleBlockPage.length > maxLength) {
        throw new RangeError('BEIGE_ALERT nation block exceeds Discord message limit');
      }

      pages.push([block]);
    }

    if (pages.length === expectedParts) {
      return pages.map((pageBlocks, index) => composeDiscordPage(
        buildHeader(index + 1, pages.length),
        pageBlocks,
      ));
    }

    expectedParts = pages.length;
  }
}

function composeDiscordPage(header, blocks) {
  return [header, ...blocks].join('\n\n');
}

function formatSafeMarkdownLink(label, url) {
  const normalizedLabel = formatLabel(label, 'Unknown', 80);
  const href = formatSafeUrl(url);

  if (!href) {
    return escapeMarkdown(normalizedLabel);
  }

  return markdownLink(normalizedLabel, href);
}

function formatSafeUrl(value) {
  const href = safeUrl(value);

  if (!href || href.length > 240) {
    return null;
  }

  return href.replaceAll('(', '%28').replaceAll(')', '%29');
}

function formatLabel(value, fallback, maxLength) {
  const normalized = value === null || value === undefined
    ? fallback
    : String(value).replace(/\s+/g, ' ').trim() || fallback;

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function buildDeclareWarUrl(nationId) {
  const normalizedId = Number(nationId);

  if (!Number.isInteger(normalizedId) || normalizedId <= 0) {
    return null;
  }

  return `https://politicsandwar.com/nation/war/declare/id=${normalizedId}`;
}

function formatDiscordTime(date, style = 'R') {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return 'Unknown time';
  }

  const seconds = Math.floor(date.getTime() / 1000);
  return `<t:${seconds}:${style}>`;
}

function formatCount(value, singular, plural) {
  const numericValue = Number(value);
  const label = numericValue === 1 ? singular : plural;
  return `${formatNumber(value, 0)} ${label}`;
}

function formatNumber(value, maximumFractionDigits = 2) {
  const numericValue = Number(value);

  if (value === null || value === undefined || !Number.isFinite(numericValue)) {
    return '—';
  }

  const formatted = new Intl.NumberFormat('en-US', { maximumFractionDigits }).format(numericValue);
  return formatted.length <= 24 ? formatted : numericValue.toExponential(2);
}

function parseDate(input) {
  if (!input) {
    return null;
  }

  const date = input instanceof Date ? input : new Date(input);
  return Number.isNaN(date.getTime()) ? null : date;
}
