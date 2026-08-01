import { SlashCommandBuilder } from 'discord.js';
import { cleanupApplicationInterviewChannel } from '../utils/applicationChannels.js';
import { isDiscordSnowflake } from '../utils/boundaryValidators.js';
import { config as runtimeConfig } from '../utils/config.js';
import { actorFromInteraction } from '../utils/commandSupport.js';
import {
  buildEmbed,
  escapeMarkdown,
  formatDiscordTime,
  markdownLink,
  nationUrl,
  resolveDeepLink,
  statusMessage,
  truncate,
} from '../utils/discordUi.js';

/**
 * /approve command to approve an applicant and perform the required guild actions.
 */
export const data = new SlashCommandBuilder()
  .setName('approve')
  .setDescription('Approve an applicant.')
  .addUserOption((option) =>
    option.setName('user').setDescription('Applicant to approve').setRequired(true),
  )
  .setDMPermission(false);

/**
 * Execute handler for /approve.
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
    command: 'approve',
    applicantId: applicant.id,
    moderatorId: moderator.id,
    guildId: interaction.guildId,
  };

  if (!interaction.guild || !guildId || interaction.guildId !== guildId) {
    await interaction.reply({ embeds: [buildErrorEmbed('This command must be used in a server.')], ephemeral: true });
    return;
  }

  if (!apiService) {
    logger.error('ApiService unavailable for /approve', logContext);
    await interaction.reply({
      embeds: [buildErrorEmbed('Approval service unavailable. Please try again later.')],
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  let response;
  try {
    response = await apiService.approveApplication(
      {
        applicant_discord_id: applicant.id,
        moderator_discord_id: moderator.id,
        approval_request_id: interaction.id,
      },
      actorFromInteraction(interaction, 'approve'),
    );
  } catch (error) {
    const { data, status } = error?.response ?? {};
    logger.warn('Nexus rejected /approve', {
      ...logContext,
      status: status ?? null,
      backendErrorCode: data?.error ?? null,
      backendMessage: data?.message ?? error?.message ?? null,
    });

    const embed = buildErrorEmbed(data?.message ?? 'Unable to approve this application right now.', data?.error);
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  const config = response?.config ?? {};
  const application = response?.application ?? {};

  const roleResult = await handleRoleChanges(interaction.guild, applicant.id, config, logger);
  const cleanupResult = await cleanupApplicationInterviewChannel({
    guild: interaction.guild,
    guildId,
    application,
    logger,
    reason: 'Nexus AMS application approved',
  });
  const announcementResult = await announceApproval(interaction.client, guildId, config, logger);
  const cleanupPending = !roleResult.success || !cleanupResult.success || !announcementResult.success;

  await interaction.editReply(statusMessage({
    title: cleanupPending ? 'Applicant Approved — Cleanup Pending' : 'Applicant Approved',
    tone: cleanupPending ? 'warning' : 'success',
    description: cleanupPending
      ? `${applicant} has been approved in Nexus, but Discord cleanup is pending. Staff should review the applicant roles, interview channel, and announcement.`
      : `${applicant} has been approved.`,
    fields: applicationFields(application, apiService.baseUrl),
    footer: cleanupPending
      ? 'The Nexus decision is complete; only the listed Discord follow-up remains.'
      : 'Nexus and Discord follow-up completed.',
    timestamp: true,
  }));
};

function applicationFields(application, baseUrl) {
  const applicationId = application?.id;
  const applicationPath = application?.deep_link_path
    ?? (applicationId ? `/admin/applications/${encodeURIComponent(applicationId)}` : null);
  const decidedAt = application?.approved_at ?? application?.updated_at;
  return [
    applicationId ? {
      name: 'Application',
      value: markdownLink(`Application #${applicationId}`, resolveDeepLink(baseUrl, applicationPath)),
      inline: true,
    } : null,
    application?.nation_id ? {
      name: 'Nation',
      value: markdownLink(`Nation #${application.nation_id}`, nationUrl({ id: application.nation_id })),
      inline: true,
    } : null,
    decidedAt ? { name: 'Decision Recorded', value: formatDiscordTime(decidedAt), inline: true } : null,
  ];
}

async function handleRoleChanges(guild, applicantId, config, logger) {
  const issues = [];
  let member;
  try {
    member = await guild.members.fetch(applicantId);
  } catch (error) {
    logger.warn('Unable to fetch applicant for role changes', { errorMessage: error?.message ?? String(error) });
    return { success: false, issues: ['member_unavailable'] };
  }

  if (isDiscordSnowflake(config?.applicant_role_id)) {
    try {
      await member.roles.remove(config.applicant_role_id, 'Nexus AMS approval');
    } catch (error) {
      logger.warn('Failed to remove applicant role during approval', { errorMessage: error?.message ?? String(error) });
      issues.push('applicant_role_removal_failed');
    }
  } else {
    issues.push('invalid_applicant_role');
  }

  if (isDiscordSnowflake(config?.member_role_id)) {
    try {
      await member.roles.add(config.member_role_id, 'Nexus AMS approval');
    } catch (error) {
      logger.warn('Failed to grant member role during approval', { errorMessage: error?.message ?? String(error) });
      issues.push('member_role_add_failed');
    }
  } else {
    issues.push('invalid_member_role');
  }

  return { success: issues.length === 0, issues };
}

async function announceApproval(client, guildId, config, logger) {
  const channelId = config?.approval_announcement_channel_id;
  if (!channelId || !config?.approval_message_template) {
    return { success: true, skipped: true };
  }

  if (!isDiscordSnowflake(channelId)) {
    logger.warn('Approval announcement channel id is invalid', { channelId });
    return { success: false, reason: 'invalid_channel_id' };
  }

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased?.() || channel.guildId !== guildId) {
      return { success: false, reason: 'invalid_announcement_channel' };
    }

    await channel.send({
      content: truncate(config.approval_message_template, 2000),
      allowedMentions: { parse: [], repliedUser: false },
    });
    return { success: true };
  } catch (error) {
    logger.warn('Failed to publish approval announcement', { errorMessage: error?.message ?? String(error) });
    return { success: false, reason: 'discord_announcement_failed' };
  }
}

function buildErrorEmbed(message, errorCode = null) {
  return buildEmbed({
    title: 'Approval Failed',
    tone: 'danger',
    description: truncate(message, 4_096),
    fields: errorCode ? [{ name: 'Error Code', value: escapeMarkdown(truncate(errorCode, 100)) }] : [],
    footer: 'No additional Discord confirmation is required; retry only after resolving the error.',
    timestamp: true,
  });
}
