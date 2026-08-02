import { isDiscordSnowflake } from './boundaryValidators.js';

/**
 * Extract a Discord channel/thread id from a war-counter response object.
 * @param {any} counter
 * @returns {string|null}
 */
export const resolveWarCounterChannelIdFromCounter = (counter) => {
  if (!counter || typeof counter !== 'object') {
    return null;
  }

  const value = typeof counter.discord_channel_id === 'string'
    ? counter.discord_channel_id.trim()
    : '';
  return isDiscordSnowflake(value) ? value : null;
};

/**
 * Rename (idempotent), archive, and lock a Discord thread for a war counter.
 * If the thread is already archived/locked, operation is treated as success.
 * @param {object} options
 * @param {import('discord.js').Client} options.client
 * @param {import('../services/Logger.js').Logger} options.logger
 * @param {string} options.channelId
 * @param {string} options.guildId configured Discord guild id
 * @param {string} [options.titlePrefix='[Archived] ']
 * @param {boolean} [options.lock=true]
 * @param {string} [options.reason='Nexus AMS war counter archive']
 * @param {object} [options.logContext={}]
 * @returns {Promise<{ success: boolean, reason?: string, channelId?: string }>}
 */
export const archiveWarCounterRoom = async ({
  client,
  logger,
  channelId,
  guildId,
  titlePrefix = '[Archived] ',
  lock = true,
  reason = 'Nexus AMS war counter archive',
  logContext = {},
}) => {
  const normalizedChannelId = typeof channelId === 'string' ? channelId.trim() : '';
  const normalizedGuildId = typeof guildId === 'string' ? guildId.trim() : '';
  const prefix = typeof titlePrefix === 'string'
    ? titlePrefix.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').slice(0, 50)
    : '[Archived] ';

  if (!isDiscordSnowflake(normalizedChannelId)) {
    logger.warn('Cannot archive war counter room without a channel id', logContext);
    return {
      success: false,
      reason: channelId === undefined || channelId === null || channelId === ''
        ? 'missing_channel'
        : 'invalid_channel_id',
    };
  }

  if (!isDiscordSnowflake(normalizedGuildId)) {
    logger.warn('Cannot archive war counter room without a valid guild id', logContext);
    return { success: false, reason: 'invalid_guild_id' };
  }

  let channel = client.channels.cache.get(normalizedChannelId) ?? null;

  if (!channel) {
    try {
      channel = await client.channels.fetch(normalizedChannelId);
    } catch (error) {
      logger.warn('Unable to fetch war counter channel', {
        ...logContext,
        channelId: normalizedChannelId,
        errorMessage: error?.message ?? String(error),
      });
      return { success: false, reason: 'channel_unavailable' };
    }
  }

  if (!channel?.isThread?.()) {
    logger.warn('War counter archive target is not a thread', {
      ...logContext,
      channelId: normalizedChannelId,
      type: channel?.type ?? 'unknown',
    });
    return { success: false, reason: 'not_thread' };
  }

  if (`${channel.guildId ?? channel.guild?.id ?? ''}` !== normalizedGuildId) {
    logger.warn('War counter archive target belongs to another guild', {
      ...logContext,
      channelId: normalizedChannelId,
      guildId: channel.guildId ?? channel.guild?.id ?? null,
    });
    return { success: false, reason: 'wrong_guild' };
  }

  const currentName = typeof channel.name === 'string' ? channel.name : '';
  const alreadyPrefixed = prefix && currentName.startsWith(prefix);

  try {
    if (!alreadyPrefixed && prefix) {
      const maxNameLength = 100;
      const nextName = `${prefix}${currentName}`.slice(0, maxNameLength);
      await channel.setName(nextName, reason);
    }

    if (!channel.archived) {
      await channel.setArchived(true, reason);
    }

    if (lock && !channel.locked) {
      await channel.setLocked(true, reason);
    }
  } catch (error) {
    logger.error('Failed to archive/lock war counter thread', {
      ...logContext,
      channelId: normalizedChannelId,
      errorMessage: error?.message ?? String(error),
    });
    return { success: false, reason: 'discord_archive_failed' };
  }

  logger.info('Archived war counter thread', {
    ...logContext,
    channelId: normalizedChannelId,
    alreadyPrefixed,
    alreadyArchived: channel.archived === true,
    alreadyLocked: channel.locked === true,
  });

  return { success: true, channelId: normalizedChannelId };
};
