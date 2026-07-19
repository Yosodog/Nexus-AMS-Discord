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
  const createdAt = command?.created_at ? new Date(command.created_at) : new Date();

  const descriptionParts = [];
  const warUrl = safeUrl(payload.war_url);
  if (warUrl) {
    descriptionParts.push(`➡️ ${markdownLink('War timeline', warUrl)}`);
  }
  const counterUrl = safeUrl(payload.counter?.url);
  if (counterUrl) {
    const counterLabel = payload.counter.id ? `Counter #${payload.counter.id}` : 'Counter';
    descriptionParts.push(`🧭 ${markdownLink(counterLabel, counterUrl)}`);
  }

  return buildEmbed({
    title: `⚔️ War Alert${payload.war_id ? ` #${payload.war_id}` : ''}`,
    color: 0xd64045,
    description: descriptionParts.join('\n') || 'A new war alert was received.',
    url: warUrl,
    fields: [
      { name: 'Attacker', value: formatParticipant(payload.attacker, '🔥'), inline: true },
      { name: 'Defender', value: formatParticipant(payload.defender, '🛡️'), inline: true },
      {
        name: 'Scores',
        value: `${formatNumber(payload.attacker?.score)} vs ${formatNumber(payload.defender?.score)}`,
        inline: true,
      },
      {
        name: 'Cities',
        value: `${formatNumber(payload.attacker?.cities)} vs ${formatNumber(payload.defender?.cities)}`,
        inline: true,
      },
      {
        name: 'Attacker Military',
        value: formatMilitary(payload.attacker?.military),
      },
      {
        name: 'Defender Military',
        value: formatMilitary(payload.defender?.military),
      },
    ],
  }).setTimestamp(createdAt);
}

function formatParticipant(side = {}, emoji = '') {
  const leader = escapeMarkdown(side.leader_name ?? 'Unknown leader');
  const nation = escapeMarkdown(side.nation_name ?? 'Unknown nation');
  const allianceName = side.alliance?.name ?? null;
  const allianceLink = side.links?.alliance ?? side.alliance?.url ?? null;
  const alliance = allianceName ? markdownLink(allianceName, allianceLink) : '—';

  const links = [];
  if (side.links?.nation) {
    links.push(markdownLink('Nation', side.links.nation));
  }
  if (side.links?.alliance) {
    links.push(markdownLink('Alliance', side.links.alliance));
  }

  const linkLine = links.length > 0 ? `🔗 ${links.join(' • ')}` : '🔗 No links provided';

  return `${emoji} **${nation}** (${leader})\nAlliance: ${alliance}\n${linkLine}`;
}

function formatMilitary(military = {}) {
  const unitOrder = [
    { key: 'soldiers', label: '🪖 Soldiers' },
    { key: 'tanks', label: '🛡️ Tanks' },
    { key: 'aircraft', label: '✈️ Aircraft' },
    { key: 'ships', label: '🚢 Ships' },
    { key: 'spies', label: '🕵️ Spies' },
    { key: 'missiles', label: '🎯 Missiles' },
    { key: 'nukes', label: '☢️ Nukes' },
  ];

  const parts = unitOrder.map(({ key, label }) => `${label}: ${formatNumber(military[key])}`);
  return parts.join(' • ');
}

function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '—';
  }

  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(value));
}
