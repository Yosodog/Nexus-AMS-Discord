import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { APPLICATION_CHANNEL_REGEX } from '../listeners/messageCreate.js';

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
export const execute = async (interaction, { logger, apiService }) => {
  const applicant = interaction.options.getUser('user', true);
  const moderator = interaction.user;

  const logContext = {
    command: 'approve',
    applicantId: applicant.id,
    moderatorId: moderator.id,
    guildId: interaction.guildId,
  };

  if (!interaction.guild) {
    await interaction.reply({ embeds: [buildErrorEmbed('This command must be used in a server.')], ephemeral: false });
    return;
  }

  if (!apiService) {
    logger.error('ApiService unavailable for /approve', logContext);
    await interaction.reply({
      embeds: [buildErrorEmbed('Approval service unavailable. Please try again later.')],
      ephemeral: false,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: false });

  let response;
  try {
    response = await apiService.approveApplication({
      applicant_discord_id: applicant.id,
      moderator_discord_id: moderator.id,
    });
  } catch (error) {
    const { data, status } = error?.response ?? {};
    logger.warn('Nexus rejected /approve', { ...logContext, status, error: data ?? error?.message ?? error });

    const embed = buildErrorEmbed(data?.message ?? 'Unable to approve this application right now.', data?.error);
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  const config = response?.config ?? {};
  const application = response?.application ?? {};

  await handleRoleChanges(interaction.guild, applicant.id, config, logger);
  await deleteInterviewChannel(interaction.guild, interaction.channel, application, logger);
  await announceApproval(interaction.client, config, logger);

  const successEmbed = new EmbedBuilder()
    .setTitle('Applicant Approved')
    .setColor(0x57f287)
    .setDescription(`${applicant} has been approved.`)
    .setTimestamp();

  await interaction.editReply({ embeds: [successEmbed] });
};

async function handleRoleChanges(guild, applicantId, config, logger) {
  let member;
  try {
    member = await guild.members.fetch(applicantId);
  } catch (error) {
    logger.warn('Unable to fetch applicant for role changes', error?.message ?? error);
    return;
  }

  if (config?.applicant_role_id) {
    try {
      await member.roles.remove(config.applicant_role_id, 'Nexus AMS approval');
    } catch (error) {
      logger.warn('Failed to remove applicant role during approval', error?.message ?? error);
    }
  }

  if (config?.member_role_id) {
    try {
      await member.roles.add(config.member_role_id, 'Nexus AMS approval');
    } catch (error) {
      logger.warn('Failed to grant member role during approval', error?.message ?? error);
    }
  }
}

async function deleteInterviewChannel(guild, currentChannel, application, logger) {
  const channelId =
    application?.discord_channel_id ?? application?.channel_id ?? application?.interview_channel_id ?? null;

  let channel = null;

  if (channelId) {
    try {
      channel = await guild.channels.fetch(channelId);
    } catch (error) {
      channel = null;
    }
  }

  if (!channel && currentChannel && APPLICATION_CHANNEL_REGEX.test(currentChannel.name)) {
    channel = currentChannel;
  }

  if (!channel) {
    const fallback = guild.channels.cache.find(
      (c) => c.isTextBased?.() && APPLICATION_CHANNEL_REGEX.test(c.name),
    );
    channel = fallback ?? null;
  }

  if (channel) {
    try {
      await channel.delete('Nexus AMS application approved');
    } catch (error) {
      logger.warn('Failed to delete interview channel after approval', error?.message ?? error);
    }
  }
}

async function announceApproval(client, config, logger) {
  const channelId = config?.approval_announcement_channel_id;
  if (!channelId || !config?.approval_message_template) {
    return;
  }

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased?.()) {
      return;
    }

    await channel.send({ content: config.approval_message_template });
  } catch (error) {
    logger.warn('Failed to publish approval announcement', error?.message ?? error);
  }
}

function buildErrorEmbed(message, errorCode) {
  const embed = new EmbedBuilder().setTitle('Approval Failed').setColor(0xed4245).setDescription(message).setTimestamp();

  if (errorCode) {
    embed.addFields({ name: 'Error', value: `\`${errorCode}\`` });
  }

  return embed;
}
