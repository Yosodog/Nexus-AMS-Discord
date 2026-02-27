import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import {
  archiveWarCounterRoom,
  buildSourceChannelKey,
  resolveWarCounterChannelIdFromCounter,
} from '../utils/warCounterRooms.js';

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
 * @param {{ logger: import('../services/Logger.js').Logger, apiService: import('../services/ApiService.js').ApiService, sourceChannelMap?: Map<string, string> }} context
 */
export const execute = async (interaction, { logger, apiService, sourceChannelMap }) => {
  const warCounterId = interaction.options.getInteger('war_counter_id', true);
  const logContext = {
    command: 'archivecounter',
    warCounterId,
    moderatorId: interaction.user?.id ?? null,
    guildId: interaction.guildId ?? null,
  };

  if (!apiService?.archiveWarCounter) {
    logger.error('ApiService unavailable for /archivecounter', logContext);
    await interaction.reply({
      embeds: [buildErrorEmbed('Archive service unavailable. Please try again later.')],
      ephemeral: false,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: false });

  let response;
  try {
    response = await apiService.archiveWarCounter({
      war_counter_id: warCounterId,
      moderator_discord_id: interaction.user.id,
    });
  } catch (error) {
    const { data, status } = error?.response ?? {};
    logger.warn('Nexus rejected /archivecounter', { ...logContext, status, error: data ?? error?.message ?? error });

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

  const sourceKey = buildSourceChannelKey('war_counter', warCounterId);
  const mappedChannelId = sourceKey ? sourceChannelMap?.get(sourceKey) ?? null : null;
  const responseChannelId = resolveWarCounterChannelIdFromCounter(response?.counter);
  const fallbackCurrentThreadId = interaction.channel?.isThread?.() ? interaction.channelId : null;
  const channelId = responseChannelId ?? mappedChannelId ?? fallbackCurrentThreadId;

  if (sourceKey && channelId && sourceChannelMap instanceof Map) {
    sourceChannelMap.set(sourceKey, channelId);
  }

  let archiveResult = { success: false, reason: 'missing_channel' };
  if (channelId) {
    archiveResult = await archiveWarCounterRoom({
      client: interaction.client,
      logger,
      channelId,
      titlePrefix: '[Archived] ',
      reason: `Nexus direct archive for war_counter ${warCounterId}`,
      logContext,
    });
  } else {
    logger.warn('No Discord channel id available for /archivecounter follow-up', logContext);
  }

  const alreadyArchived = Boolean(response?.already_archived);
  const discordArchived = archiveResult.success;

  const embed = new EmbedBuilder()
    .setTitle('War Counter Archived')
    .setColor(discordArchived ? 0x57f287 : 0xfaa61a)
    .setDescription(
      [
        `Counter **#${warCounterId}** archived in Nexus.`,
        alreadyArchived ? 'Nexus indicated this counter was already archived.' : null,
        discordArchived
          ? `Discord thread archived and locked (<#${channelId}>).`
          : 'Nexus archived the counter, but Discord thread archive could not be completed automatically.',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
};

function buildErrorEmbed(message, errorCode) {
  const embed = new EmbedBuilder()
    .setTitle('Archive Failed')
    .setColor(0xed4245)
    .setDescription(message)
    .setTimestamp();

  if (errorCode) {
    embed.addFields({ name: 'Error', value: `\`${errorCode}\`` });
  }

  return embed;
}
