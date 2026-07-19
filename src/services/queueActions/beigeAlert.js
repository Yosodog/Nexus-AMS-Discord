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
  const headerParts = ['🟨 **Beige Watch**', eventLabel, `Nations: **${formatNumber(count)}**`];

  if (turnTime) {
    headerParts.push(
      `Turn: ${formatDiscordTime(turnTime, 'f')} (${formatDiscordTime(turnTime, 'R')})`,
    );
  } else if (createdAt) {
    headerParts.push(`Updated: ${formatDiscordTime(createdAt, 'R')}`);
  }

  const lines = nations.map((nation, index) => {
    const nationName = nation?.nation_name ?? 'Unknown nation';
    const leader = nation?.leader_name ?? 'Unknown leader';
    const nationLink = nation?.links?.nation ?? null;
    const allianceName = nation?.alliance?.name ?? 'No alliance';
    const allianceLink = nation?.links?.alliance ?? null;
    const score = formatNumber(nation?.score);
    const cities = formatNumber(nation?.cities);
    const beigeTurns = formatNumber(nation?.beige_turns);
    const military = nation?.military ?? {};
    const declareWarUrl = buildDeclareWarUrl(nation?.id);

    const nationLabel = nationLink ? `[${nationName}](${nationLink})` : nationName;
    const allianceLabel = allianceLink ? `[${allianceName}](${allianceLink})` : allianceName;
    const declareWarLabel = declareWarUrl ? `[Declare War](${declareWarUrl})` : 'Declare War: —';

    return `${index + 1}. ${nationLabel} (${leader}) | ${allianceLabel} | ${declareWarLabel} | Score: ${score} | Cities: ${cities} | Beige: ${beigeTurns} | Mil: 🪖 ${formatNumber(military.soldiers)} • 🛡️ ${formatNumber(military.tanks)} • ✈️ ${formatNumber(military.aircraft)} • 🚢 ${formatNumber(military.ships)} • 🕵️ ${formatNumber(military.spies)} • 🎯 ${formatNumber(military.missiles)} • ☢️ ${formatNumber(military.nukes)}`;
  });

  return chunkDiscordMessage([headerParts.join(' | '), ...lines].join('\n'));
}

function buildBeigeExitEmbed(command) {
  const payload = command?.payload ?? {};
  const nation = payload.nation ?? {};
  const createdAt = parseDate(command?.created_at) ?? new Date();
  const detectedAt = parseDate(payload.detected_at) ?? createdAt;
  const nationLabel = nation.nation_name ?? 'Unknown nation';
  const leader = nation.leader_name ?? 'Unknown leader';
  const declareWarUrl = buildDeclareWarUrl(nation.id);
  const declareWarLink = declareWarUrl ? markdownLink('Open declare war page', declareWarUrl) : 'Unavailable';
  const nationLink = safeUrl(nation.links?.nation);

  return buildEmbed({
    title: '🟨 Beige Exit Alert',
    color: 0xd4b06a,
    description: `**${escapeMarkdown(leader)}** of ${markdownLink(nationLabel, nationLink)} is no longer beige.`,
    url: nationLink,
    fields: [
      {
        name: 'Nation',
        value: `${markdownLink(nationLabel, nationLink)}\nLeader: ${escapeMarkdown(leader)}`,
        inline: true,
      },
      {
        name: 'Alliance',
        value: formatAllianceWithLink(nation),
        inline: true,
      },
      {
        name: 'Stats',
        value: `Score: ${formatNumber(nation.score)}\nCities: ${formatNumber(nation.cities)}\nPrevious Beige Turns: ${formatNumber(payload.previous_beige_turns ?? 0)}`,
        inline: true,
      },
      {
        name: 'Military Snapshot',
        value: formatMilitaryMultiline(nation.military),
      },
      {
        name: 'Detected',
        value: `${formatDiscordTime(detectedAt, 'f')} (${formatDiscordTime(detectedAt, 'R')})`,
      },
      {
        name: 'War Link',
        value: `⚔️ ${declareWarLink}`,
      },
    ],
    footer: `Event: ${payload.event_type ?? 'beige_exit'}`,
  }).setTimestamp(detectedAt);
}

function formatAllianceWithLink(nation = {}) {
  const alliance = nation.alliance ?? {};
  const name = alliance.name ?? 'No alliance';
  const link = nation.links?.alliance ?? null;

  return markdownLink(name, link);
}

function formatMilitaryMultiline(military = {}) {
  return [
    `🪖 Soldiers: ${formatNumber(military.soldiers)}`,
    `🛡️ Tanks: ${formatNumber(military.tanks)}`,
    `✈️ Aircraft: ${formatNumber(military.aircraft)}`,
    `🚢 Ships: ${formatNumber(military.ships)}`,
    `🕵️ Spies: ${formatNumber(military.spies)}`,
    `🎯 Missiles: ${formatNumber(military.missiles)}`,
    `☢️ Nukes: ${formatNumber(military.nukes)}`,
  ].join('\n');
}

function describeBeigeEvent(eventType, window) {
  if (eventType === 'upcoming_turn_exit') {
    return 'Expected exits this turn';
  }

  if (eventType === 'turn_exit') {
    return 'Exited this turn';
  }

  if (eventType === 'early_exit') {
    return 'Early beige exits';
  }

  if (window === 'pre_turn') {
    return 'Pre-turn beige status';
  }

  if (window === 'post_turn') {
    return 'Post-turn beige status';
  }

  return 'Beige status update';
}

function chunkDiscordMessage(text, maxLength = 1900) {
  if (typeof text !== 'string' || text.length <= maxLength) {
    return [text];
  }

  const lines = text.split('\n');
  const chunks = [];
  let currentChunk = '';

  for (const line of lines) {
    if (!line) {
      continue;
    }

    const withNewline = currentChunk ? `${currentChunk}\n${line}` : line;
    if (withNewline.length <= maxLength) {
      currentChunk = withNewline;
      continue;
    }

    if (currentChunk) {
      chunks.push(currentChunk);
    }

    if (line.length > maxLength) {
      for (let i = 0; i < line.length; i += maxLength) {
        chunks.push(line.slice(i, i + maxLength));
      }
      currentChunk = '';
    } else {
      currentChunk = line;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks;
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

function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '—';
  }

  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(value));
}

function parseDate(input) {
  if (!input) {
    return null;
  }

  const date = input instanceof Date ? input : new Date(input);
  return Number.isNaN(date.getTime()) ? null : date;
}
