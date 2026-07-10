import { EmbedBuilder } from 'discord.js';
import { isDiscordSnowflake } from '../../utils/boundaryValidators.js';

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
        ? 'ALLIANCE_DEPARTURE payload missing channel_id'
        : validation.reason === 'invalid_channel'
          ? 'ALLIANCE_DEPARTURE payload has invalid channel_id'
          : 'ALLIANCE_DEPARTURE payload is invalid',
      command?.id ?? 'unknown',
    );
    return { success: false, reason: validation.reason };
  }

  const channelId = payload.channel_id.trim();
  const channel = await context.resolveTextChannel(channelId);

  if (!channel) {
    context.logger.warn('ALLIANCE_DEPARTURE channel missing or inaccessible', {
      channelId,
      commandId: command?.id,
    });
    return { success: false, reason: 'channel_unavailable' };
  }

  const embed = buildAllianceDepartureEmbed(command);

  try {
    if (!context.canContinue()) return { success: false, reason: 'lease_lost' };
    await context.send(
      channel,
      command,
      'alliance-departure',
      { embeds: [embed] },
      'send ALLIANCE_DEPARTURE embed',
    );
    context.logger.info('Delivered ALLIANCE_DEPARTURE embed', {
      commandId: command?.id,
      channelId,
    });
    return { success: true };
  } catch (error) {
    context.logger.error(
      'Failed to send ALLIANCE_DEPARTURE embed to Discord',
      error?.message ?? error,
    );
    return { success: false, reason: 'discord_send_failed' };
  }
};

function buildAllianceDepartureEmbed(command) {
  const payload = command?.payload ?? {};
  const nation = payload.nation ?? {};
  const leftAt = parseDate(payload.left_at);
  const createdAt = parseDate(command?.created_at) ?? new Date();
  const timestamp = leftAt ?? createdAt;

  const embed = new EmbedBuilder().setTitle('🏳️ Alliance Departure').setColor(0xf59f00);

  if (nation.links?.nation) {
    embed.setURL(nation.links.nation);
  }

  const descriptionLines = [
    `${nation.leader_name ?? 'A nation'} (${nation.nation_name ?? 'Unknown nation'}) has left ${
      formatAlliance(payload.previous_alliance) ?? 'an alliance'
    }.`,
  ];

  if (payload.new_alliance) {
    descriptionLines.push(`New allegiance: ${formatAlliance(payload.new_alliance)}.`);
  } else {
    descriptionLines.push('They are currently unaffiliated.');
  }

  if (nation.links?.nation) {
    descriptionLines.push(`🔗 [Nation Profile](${nation.links.nation})`);
  }

  embed
    .setDescription(descriptionLines.join('\n'))
    .addFields(
      {
        name: 'Previous Alliance',
        value: formatAlliance(payload.previous_alliance) ?? 'Unknown',
        inline: true,
      },
      {
        name: 'New Alliance',
        value: formatAlliance(payload.new_alliance) ?? 'Unaffiliated',
        inline: true,
      },
      {
        name: 'Timing',
        value: leftAt
          ? `${formatDiscordTime(leftAt, 'f')} (${formatDiscordTime(leftAt, 'R')})`
          : formatDiscordTime(createdAt, 'R'),
      },
    )
    .setTimestamp(timestamp);

  return embed;
}

function formatAlliance(alliance) {
  if (!alliance || typeof alliance !== 'object') {
    return null;
  }

  const name = alliance.name ?? 'Unknown alliance';
  if (alliance.link) {
    return `[${name}](${alliance.link})`;
  }

  return name;
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
