import { isDiscordSnowflake } from '../../utils/boundaryValidators.js';
import {
  buildEmbed,
  escapeMarkdown,
  markdownLink,
  nationUrl,
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
        ? 'INACTIVITY_ALERT payload missing channel_id'
        : validation.reason === 'invalid_channel'
          ? 'INACTIVITY_ALERT payload has invalid channel_id'
          : 'INACTIVITY_ALERT payload is invalid',
      command?.id ?? 'unknown',
    );
    return { success: false, reason: validation.reason };
  }

  const channelId = payload.channel_id.trim();
  const channel = await context.resolveTextChannel(channelId);

  if (!channel) {
    context.logger.warn('INACTIVITY_ALERT channel missing or inaccessible', {
      channelId,
      commandId: command?.id,
    });
    return { success: false, reason: 'channel_unavailable' };
  }

  const embed = buildInactivityAlertEmbed(command);
  const mentionUserId = normalizeSnowflake(payload.discord_user_id);
  const mention = mentionUserId ? `<@${mentionUserId}>` : null;

  try {
    if (!context.canContinue()) return { success: false, reason: 'lease_lost' };
    await context.send(
      channel,
      command,
      'inactivity-alert',
      {
        content: mention ?? undefined,
        embeds: [embed],
        allowedMentions: mentionUserId ? { users: [mentionUserId] } : { parse: [] },
      },
      'send INACTIVITY_ALERT message',
    );
    context.logger.info('Delivered INACTIVITY_ALERT message', {
      commandId: command?.id,
      channelId,
    });
    return { success: true };
  } catch (error) {
    context.logger.error(
      'Failed to send INACTIVITY_ALERT message to Discord',
      error?.message ?? error,
    );
    return { success: false, reason: 'discord_send_failed' };
  }
};

function buildInactivityAlertEmbed(command) {
  const payload = command?.payload ?? {};
  const leader = payload.leader_name ?? 'Unknown leader';
  const nationName = payload.nation_name ?? 'Unknown nation';
  const nationId = payload.nation_id ? `, #${payload.nation_id}` : '';
  const lastActiveAt = parseDate(payload.last_active_at);
  const createdAt = parseDate(command?.created_at) ?? new Date();
  const threshold = payload.threshold_hours ?? extractThresholdFromMessage(payload.message);

  const profileUrl = nationUrl({ id: payload.nation_id });
  const fields = [{
      name: 'Last Active',
      value: lastActiveAt
        ? `${formatDiscordTime(lastActiveAt, 'f')} (${formatDiscordTime(lastActiveAt, 'R')})`
        : 'Unknown',
    }];

  if (threshold) {
    fields.push({ name: 'Threshold', value: `${threshold}h`, inline: true });
  }

  return buildEmbed({
    title: '⏰ Inactivity Alert',
    color: 0xe67700,
    description: `**${escapeMarkdown(leader)}** (${markdownLink(`${nationName}${nationId}`, profileUrl)}) has exceeded inactivity limits.`,
    fields,
    url: profileUrl,
  }).setTimestamp(lastActiveAt ?? createdAt);
}

function normalizeSnowflake(value) {
  const normalized = `${value ?? ''}`.trim();
  return isDiscordSnowflake(normalized) ? normalized : null;
}

function extractThresholdFromMessage(message) {
  if (typeof message !== 'string') {
    return null;
  }

  const match = message.match(/threshold:\s*(\d+)h/i);
  return match?.[1] ?? null;
}

function formatDiscordTime(date, style = 'R') {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return 'Unknown time';
  }

  const seconds = Math.floor(date.getTime() / 1000);
  return `<t:${seconds}:${style}>`;
}

function parseDate(input) {
  if (!input) {
    return null;
  }

  const date = input instanceof Date ? input : new Date(input);
  return Number.isNaN(date.getTime()) ? null : date;
}
