import { Events } from 'discord.js';
import { config } from '../utils/config.js';

export const APPLICATION_CHANNEL_REGEX = /^app-[0-9]+-[0-9]+/i;
export const INTEL_REPORT_REGEX = /^(?:\s*)[A-Za-z]{0,3}\s*successfully gather(?:ed)? intelligence about .+?The operation cost you \$[0-9,]+\.[0-9]{2} and \d+ of your spies were captured and executed\.?(?:\s*)$/is;

/**
 * Register a listener that forwards application messages and intel reports to Nexus.
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

    const content = typeof message.content === 'string' ? message.content : '';

    if (content && INTEL_REPORT_REGEX.test(content)) {
      await handleIntelReport(message, content, apiService, logger);
    }

    if (!APPLICATION_CHANNEL_REGEX.test(message.channel.name)) {
      return;
    }

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

async function handleIntelReport(message, content, apiService, logger) {
  if (!apiService) {
    logger.warn('ApiService missing; unable to forward intel report.');
    return;
  }

  const payload = { report: content, source: 'discord' };

  try {
    await apiService.sendIntelReport(payload);

    const intelUrl = new URL('/defense/intel', config.nexusApi.baseUrl).toString();
    const replyMessage = `Intel report saved. View it at ${intelUrl}`;

    await message.reply(replyMessage).catch((error) => {
      logger.warn('Failed to send intel confirmation message', error?.message ?? error);
    });
  } catch (error) {
    const { status, data } = error?.response ?? {};
    logger.warn('Failed to submit intel report to Nexus', {
      channelId: message.channelId,
      messageId: message.id,
      status,
      error: data ?? error?.message ?? error,
    });
  }
}
