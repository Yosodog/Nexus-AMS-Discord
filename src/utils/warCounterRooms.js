/**
 * Build a stable in-memory key for source-to-channel mapping.
 * @param {string} sourceType
 * @param {number|string} sourceId
 * @returns {string|null}
 */
export const buildSourceChannelKey = (sourceType, sourceId) => {
  const type = typeof sourceType === 'string' ? sourceType.trim().toLowerCase() : '';
  const id = `${sourceId ?? ''}`.trim();

  if (!type || !id) {
    return null;
  }

  return `${type}:${id}`;
};

/**
 * Extract a Discord channel/thread id from a war-counter response object.
 * @param {any} counter
 * @returns {string|null}
 */
export const resolveWarCounterChannelIdFromCounter = (counter) => {
  if (!counter || typeof counter !== 'object') {
    return null;
  }

  const candidates = [
    counter.discord_channel_id,
    counter.discord_thread_id,
    counter.channel_id,
    counter.thread_id,
  ];

  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) {
      continue;
    }

    const value = `${candidate}`.trim();
    if (value !== '') {
      return value;
    }
  }

  return null;
};

/**
 * Rename (idempotent), archive, and lock a Discord thread for a war counter.
 * If the thread is already archived/locked, operation is treated as success.
 * @param {object} options
 * @param {import('discord.js').Client} options.client
 * @param {import('../services/Logger.js').Logger} options.logger
 * @param {string} options.channelId
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
  titlePrefix = '[Archived] ',
  lock = true,
  reason = 'Nexus AMS war counter archive',
  logContext = {},
}) => {
  const normalizedChannelId = `${channelId ?? ''}`.trim();
  const prefix = typeof titlePrefix === 'string' ? titlePrefix : '[Archived] ';

  if (!normalizedChannelId) {
    logger.warn('Cannot archive war counter room without a channel id', logContext);
    return { success: false, reason: 'missing_channel' };
  }

  let channel = client.channels.cache.get(normalizedChannelId) ?? null;

  if (!channel) {
    try {
      channel = await client.channels.fetch(normalizedChannelId);
    } catch (error) {
      logger.warn('Unable to fetch war counter channel', {
        ...logContext,
        channelId: normalizedChannelId,
        error: error?.message ?? error,
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
      error: error?.message ?? error,
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
