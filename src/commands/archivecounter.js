import { SlashCommandBuilder } from 'discord.js';
import {
  archiveWarCounterRoom,
  resolveWarCounterChannelIdFromCounter,
} from '../utils/warCounterRooms.js';
import { config as runtimeConfig } from '../utils/config.js';
import {
  buildEmbed,
  escapeMarkdown,
  formatDiscordTime,
  markdownLink,
  resolveDeepLink,
  statusMessage,
  truncate,
} from '../utils/discordUi.js';

export const data = new SlashCommandBuilder()
  .setName('archivecounter')
  .setDescription('Archive a war counter and lock its Discord thread.')
  .addIntegerOption((option) =>
    option
      .setName('war_counter_id')
      .setDescription('War counter ID to archive.')
      .setRequired(true),
  )
  .setDMPermission(false);

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ logger: import('../services/Logger.js').Logger, apiService: import('../services/ApiService.js').ApiService, guildId?: string }} context
 */
export const execute = async (
  interaction,
  { logger, apiService, guildId = runtimeConfig.discord.guildId },
) => {
  const warCounterId = interaction.options.getInteger('war_counter_id', true);
  const logContext = {
    command: 'archivecounter',
    warCounterId,
    moderatorId: interaction.user?.id ?? null,
    guildId: interaction.guildId ?? null,
  };

  if (!interaction.guild || !guildId || interaction.guildId !== guildId) {
    await interaction.reply({
      embeds: [buildErrorEmbed('This command must be used in the configured server.')],
      ephemeral: true,
    });
    return;
  }

  if (!apiService?.archiveWarCounter) {
    logger.error('ApiService unavailable for /archivecounter', logContext);
    await interaction.reply({
      embeds: [buildErrorEmbed('Archive service unavailable. Please try again later.')],
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  let response;
  try {
    response = await apiService.archiveWarCounter({
      war_counter_id: warCounterId,
      moderator_discord_id: interaction.user.id,
    });
  } catch (error) {
    const { data, status } = error?.response ?? {};
    logger.warn('Nexus rejected /archivecounter', {
      ...logContext,
      status: status ?? null,
      backendErrorCode: data?.error ?? null,
      backendMessage: data?.message ?? error?.message ?? null,
    });

    if (status === 403 && data?.error === 'moderator_not_found') {
      await interaction.editReply({
        embeds: [
          buildErrorEmbed(
            'Your Discord account is not linked in Nexus. Please link your Discord account in Nexus, then retry.',
            data?.error,
          ),
        ],
      });
      return;
    }

    if (status === 403 && data?.error === 'forbidden') {
      await interaction.editReply({
        embeds: [
          buildErrorEmbed(
            'Permission denied. You do not have permission to manage war counters in Nexus.',
            data?.error,
          ),
        ],
      });
      return;
    }

    await interaction.editReply({
      embeds: [buildErrorEmbed(data?.message ?? 'Unable to archive that war counter right now.', data?.error)],
    });
    return;
  }

  const channelId = resolveWarCounterChannelIdFromCounter(response?.counter);

  let archiveResult = { success: false, reason: 'missing_channel' };
  if (channelId) {
    archiveResult = await archiveWarCounterRoom({
      client: interaction.client,
      logger,
      channelId,
      guildId,
      titlePrefix: '[Archived] ',
      reason: `Nexus direct archive for war_counter ${warCounterId}`,
      logContext,
    });
  } else {
    logger.warn('No Discord channel id available for /archivecounter follow-up', logContext);
  }

  const alreadyArchived = Boolean(response?.already_archived);
  const discordArchived = archiveResult.success;
  const counter = response?.counter ?? {};
  const counterPath = counter.deep_link_path ?? `/admin/war-counters/${encodeURIComponent(warCounterId)}`;
  await interaction.editReply(statusMessage({
    title: 'War Counter Archived',
    tone: discordArchived ? 'success' : 'warning',
    description: [
      `Counter **#${warCounterId}** archived in Nexus.`,
      alreadyArchived ? 'Nexus indicated this counter was already archived.' : null,
      discordArchived
        ? `Discord thread archived and locked (<#${channelId}>).`
        : 'Nexus archived the counter, but Discord thread archive could not be completed automatically.',
    ].filter(Boolean).join('\n'),
    fields: [
      {
        name: 'War Counter',
        value: markdownLink(
          `Counter #${warCounterId}`,
          resolveDeepLink(apiService.baseUrl, counterPath),
        ),
        inline: true,
      },
      channelId ? {
        name: 'Discord Thread',
        value: discordArchived ? `<#${channelId}> · Archived and locked` : `<#${channelId}> · Follow-up required`,
        inline: true,
      } : { name: 'Discord Thread', value: 'No channel is attached in Nexus.', inline: true },
      counter.archived_at || counter.updated_at ? {
        name: 'Archived',
        value: formatDiscordTime(counter.archived_at ?? counter.updated_at),
        inline: true,
      } : null,
    ],
    footer: discordArchived
      ? 'Nexus and Discord archive steps completed.'
      : 'The Nexus archive is complete; staff should finish the Discord follow-up.',
    timestamp: true,
  }));
};

function buildErrorEmbed(message, errorCode = null) {
  return buildEmbed({
    title: 'Archive Failed',
    tone: 'danger',
    description: truncate(message, 4_096),
    fields: errorCode ? [{ name: 'Error Code', value: escapeMarkdown(truncate(errorCode, 100)) }] : [],
    timestamp: true,
  });
}
