import { Events } from 'discord.js';

export const APPLICATION_CHANNEL_REGEX = /^app-[0-9]+-[0-9]+/i;

/**
 * Register a listener that forwards application channel messages to Nexus.
 * @param {import('discord.js').Client} client Discord client
 * @param {import('../services/ApiService.js').ApiService} apiService Nexus API service
 * @param {import('../services/Logger.js').Logger} logger structured logger
 */
export const registerMessageListener = (client, apiService, logger) => {
  if (!apiService) {
    logger.warn('ApiService missing; skipping message listener registration.');
    return;
  }

  client.on(Events.MessageCreate, async (message) => {
    if (!message.guild || !message.channel?.name) {
      return;
    }

    if (!APPLICATION_CHANNEL_REGEX.test(message.channel.name)) {
      return;
    }

    const content = typeof message.content === 'string' ? message.content : '';

    // Skip logging if there is no textual content and no attachments to avoid noisy errors for embed-only messages.
    if (!content && (!message.attachments || message.attachments.size === 0)) {
      return;
    }

    const payload = {
      discord_channel_id: message.channelId,
      discord_message_id: message.id,
      discord_user_id: message.author?.id ?? 'unknown',
      discord_username: message.author?.tag ?? message.author?.username ?? 'unknown',
      content,
      sent_at: Math.floor(message.createdTimestamp / 1000),
      is_staff: false,
    };

    try {
      const result = await apiService.logApplicationMessage(payload);
      if (result?.logged === false) {
        logger.debug('Nexus declined to log message', { channelId: message.channelId, messageId: message.id });
      }
    } catch (error) {
      logger.warn('Failed to log application message to Nexus', {
        channelId: message.channelId,
        messageId: message.id,
        error: error?.message ?? error,
      });
    }
  });
};
