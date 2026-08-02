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

  return { valid: true };
};

export const execute = async (command, context) => {
  const payload = command?.payload;
  const validation = validate(payload);

  if (!validation.valid) {
    context.logger.warn(
      validation.reason === 'missing_channel'
        ? 'WAR_ALERT payload missing channel_id'
        : validation.reason === 'invalid_channel'
          ? 'WAR_ALERT payload has invalid channel_id'
          : 'WAR_ALERT payload is invalid',
      command?.id ?? 'unknown',
    );
    return { success: false, reason: validation.reason };
  }

  const channelId = payload.channel_id.trim();
  const channel = await context.resolveTextChannel(channelId);

  if (!channel) {
    context.logger.warn('WAR_ALERT channel missing or inaccessible', {
      channelId,
      commandId: command?.id,
    });
    return { success: false, reason: 'channel_unavailable' };
  }

  const embed = buildWarAlertEmbed(command);

  try {
    if (!context.canContinue()) return { success: false, reason: 'lease_lost' };
    await context.send(
      channel,
      command,
      'war-alert',
      { embeds: [embed] },
      'send WAR_ALERT embed',
    );
    context.logger.info('Delivered WAR_ALERT embed', { commandId: command?.id, channelId });
    return { success: true };
  } catch (error) {
    context.logger.error('Failed to send WAR_ALERT embed to Discord', error?.message ?? error);
    return { success: false, reason: 'discord_send_failed' };
  }
};

function buildWarAlertEmbed(command) {
  const payload = command?.payload ?? {};
  const rawCreatedAt = command?.created_at ? new Date(command.created_at) : null;
  const createdAt = rawCreatedAt && !Number.isNaN(rawCreatedAt.getTime()) ? rawCreatedAt : new Date();
  const warUrl = safeUrl(payload.war_url);
  const attackerNation = formatNation(payload.attacker);
  const defenderNation = formatNation(payload.defender);
  const descriptionParts = [
    `**${attackerNation}** declared war on **${defenderNation}**.`,
  ];

  const links = [];
  if (warUrl) {
    links.push(markdownLink('War timeline', warUrl));
  }

  const counterUrl = safeUrl(payload.counter?.url);
  if (counterUrl) {
    const counterLabel = payload.counter.id ? `Counter #${payload.counter.id}` : 'Counter';
    links.push(markdownLink(counterLabel, counterUrl));
  }

  if (links.length > 0) {
    descriptionParts.push(links.join(' · '));
  }

  const warId = Number.isSafeInteger(payload.war_id) && payload.war_id > 0
    ? ` #${payload.war_id}`
    : '';

  return buildEmbed({
    title: `⚔️ War${warId} Declared`,
    color: 0xd64045,
    description: descriptionParts.join('\n\n'),
    url: warUrl,
    fields: [
      { name: 'Attacker', value: formatParticipant(payload.attacker), inline: true },
      { name: 'Defender', value: formatParticipant(payload.defender), inline: true },
      {
        name: 'Attacker military',
        value: formatMilitary(payload.attacker?.military),
      },
      {
        name: 'Defender military',
        value: formatMilitary(payload.defender?.military),
      },
    ],
  }).setTimestamp(createdAt);
}

function formatNation(side = {}) {
  return markdownLink(side.nation_name ?? 'Unknown nation', side.links?.nation);
}

function formatParticipant(side = {}) {
  const leader = escapeMarkdown(side.leader_name ?? 'Unknown leader');
  const allianceName = side.alliance?.name ?? null;
  const allianceLink = side.links?.alliance ?? side.alliance?.url ?? null;
  const alliance = allianceName ? markdownLink(allianceName, allianceLink) : 'No alliance';

  return `**${leader}** — ${alliance}\n${formatNumber(side.score)} score · ${formatNumber(side.cities)} cities`;
}

function formatMilitary(military = {}) {
  const conventional = [
    ['soldiers', 'Soldiers'],
    ['tanks', 'Tanks'],
    ['aircraft', 'Aircraft'],
    ['ships', 'Ships'],
  ];
  const strategic = [
    ['spies', 'Spies'],
    ['missiles', 'Missiles'],
    ['nukes', 'Nukes'],
  ];
  const formatUnits = (units) => units
    .map(([key, label]) => `${label} ${formatNumber(military[key])}`)
    .join(' · ');

  return `${formatUnits(conventional)}\n${formatUnits(strategic)}`;
}

function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '—';
  }

  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(value));
}
