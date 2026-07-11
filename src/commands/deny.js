import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { cleanupApplicationInterviewChannel } from '../utils/applicationChannels.js';
import { isDiscordSnowflake } from '../utils/boundaryValidators.js';
import { config as runtimeConfig } from '../utils/config.js';

/**
 * /deny command to deny an applicant and clean up their interview channel.
 */
export const data = new SlashCommandBuilder()
  .setName('deny')
  .setDescription('Deny an applicant.')
  .addUserOption((option) =>
    option.setName('user').setDescription('Applicant to deny').setRequired(true),
  )
  .setDMPermission(false);

/**
 * Execute handler for /deny.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction command interaction
 * @param {{ logger: import('../services/Logger.js').Logger, apiService: import('../services/ApiService.js').ApiService }} context dependencies
 */
export const execute = async (
  interaction,
  { logger, apiService, guildId = runtimeConfig.discord.guildId },
) => {
  const applicant = interaction.options.getUser('user', true);
  const moderator = interaction.user;

  const logContext = {
    command: 'deny',
    applicantId: applicant.id,
    moderatorId: moderator.id,
    guildId: interaction.guildId,
  };

  if (!interaction.guild || !guildId || interaction.guildId !== guildId) {
    await interaction.reply({ embeds: [buildErrorEmbed('This command must be used in a server.')], ephemeral: true });
    return;
  }

  if (!apiService) {
    logger.error('ApiService unavailable for /deny', logContext);
    await interaction.reply({
      embeds: [buildErrorEmbed('Denial service unavailable. Please try again later.')],
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  let response;
  try {
    response = await apiService.denyApplication({
      applicant_discord_id: applicant.id,
      moderator_discord_id: moderator.id,
      denial_request_id: interaction.id,
    });
  } catch (error) {
    const { data, status } = error?.response ?? {};
    logger.warn('Nexus rejected /deny', {
      ...logContext,
      status: status ?? null,
      backendErrorCode: data?.error ?? null,
      backendMessage: data?.message ?? error?.message ?? null,
    });

    const embed = buildErrorEmbed(data?.message ?? 'Unable to deny this application right now.', data?.error);
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  const config = response?.config ?? {};
  const application = response?.application ?? {};

  const roleResult = await handleRoleRemoval(interaction.guild, applicant.id, config, logger);
  const cleanupResult = await cleanupApplicationInterviewChannel({
    guild: interaction.guild,
    guildId,
    application,
    logger,
    reason: 'Nexus AMS application denied',
  });
  const cleanupPending = !roleResult.success || !cleanupResult.success;

  const successEmbed = new EmbedBuilder()
    .setTitle(cleanupPending ? 'Applicant Denied — Cleanup Pending' : 'Applicant Denied')
    .setColor(cleanupPending ? 0xfaa61a : 0xed4245)
    .setDescription(
      cleanupPending
        ? `${applicant} has been denied in Nexus, but Discord cleanup is pending. Staff should review the applicant role and interview channel.`
        : `${applicant} has been denied.`,
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [successEmbed] });
};

async function handleRoleRemoval(guild, applicantId, config, logger) {
  if (!isDiscordSnowflake(config?.applicant_role_id)) {
    logger.warn('Applicant role id is missing or invalid during denial');
    return { success: false, issues: ['invalid_applicant_role'] };
  }

  let member;
  try {
    member = await guild.members.fetch(applicantId);
  } catch (error) {
    logger.warn('Unable to fetch applicant for role removal', { errorMessage: error?.message ?? String(error) });
    return { success: false, issues: ['member_unavailable'] };
  }

  try {
    await member.roles.remove(config.applicant_role_id, 'Nexus AMS denial');
    return { success: true, issues: [] };
  } catch (error) {
    logger.warn('Failed to remove applicant role during denial', { errorMessage: error?.message ?? String(error) });
    return { success: false, issues: ['applicant_role_removal_failed'] };
  }
}

function buildErrorEmbed(message, errorCode) {
  const embed = new EmbedBuilder().setTitle('Denial Failed').setColor(0xed4245).setDescription(message).setTimestamp();

  if (errorCode) {
    embed.addFields({ name: 'Error', value: `\`${errorCode}\`` });
  }

  return embed;
}
