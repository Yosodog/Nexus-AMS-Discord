import { Events } from 'discord.js';
import {
  LEGACY_APPLICATION_CHANNEL_REGEX,
  parseApplicationChannelIdentity,
} from '../utils/applicationChannels.js';
import { config } from '../utils/config.js';
import { markdownLink, statusMessage } from '../utils/discordUi.js';

export const APPLICATION_CHANNEL_REGEX = LEGACY_APPLICATION_CHANNEL_REGEX;
export const INTEL_REPORT_REGEX = /^(?:\s*)[A-Za-z]{0,3}\s*successfully gather(?:ed)? intelligence about .+?The operation cost you \$[0-9,]+\.[0-9]{2} and \d+ of your spies were captured and executed\.?(?:\s*)$/is;

/**
 * Register a listener that forwards application messages and intel reports to Nexus.
 * @param {import('discord.js').Client} client Discord client
 * @param {import('../services/ApiService.js').ApiService} apiService Nexus API service
 * @param {import('../services/Logger.js').Logger} logger structured logger
 */
export const registerMessageListener = (
  client,
  apiService,
  logger,
  guildId = config.discord.guildId,
) => {
  if (!apiService) {
    logger.warn('ApiService missing; skipping message listener registration.');
    return;
  }

  client.on(Events.MessageCreate, async (message) => {
    if (!guildId || message.guild?.id !== guildId || !message.channel) {
      return;
    }
    if (message.author?.bot || message.webhookId) return;

    const content = typeof message.content === 'string' ? message.content : '';

    if (content && INTEL_REPORT_REGEX.test(content)) {
      await handleIntelReport(message, content, apiService, logger);
    }

    if (!parseApplicationChannelIdentity(message.channel)) {
      return;
    }

    // Application transcripts are deliberately text-only. Attachments remain in Discord.
    if (content.trim().length === 0) {
      return;
    }

    const payload = {
      discord_channel_id: message.channelId,
      discord_message_id: message.id,
      discord_user_id: message.author?.id ?? 'unknown',
      discord_username: message.author?.tag ?? message.author?.username ?? 'unknown',
      content,
      sent_at: Math.floor(message.createdTimestamp / 1000),
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
        errorMessage: error?.message ?? String(error),
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
    await message.reply({
      ...statusMessage({
        title: 'Intel Report Saved',
        tone: 'success',
        description: `${markdownLink('Open the intelligence dashboard', intelUrl)} to review the report.`,
      }),
      allowedMentions: { parse: [], repliedUser: false },
    }).catch((error) => {
      logger.warn('Failed to send intel confirmation message', {
        errorMessage: error?.message ?? String(error),
      });
    });
  } catch (error) {
    const { status, data } = error?.response ?? {};
    logger.warn('Failed to submit intel report to Nexus', {
      channelId: message.channelId,
      messageId: message.id,
      status: status ?? null,
      backendErrorCode: data?.error ?? null,
      backendMessage: data?.message ?? error?.message ?? null,
    });
    await message.reply({
      ...statusMessage({
        title: 'Intel Report Not Saved',
        tone: 'danger',
        description: 'Nexus could not save that report. Try posting it again in a moment.',
      }),
      allowedMentions: { parse: [], repliedUser: false },
    }).catch(() => {});
  }
}
