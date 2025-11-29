import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { APPLICATION_CHANNEL_REGEX } from '../listeners/messageCreate.js';

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
export const execute = async (interaction, { logger, apiService }) => {
  const applicant = interaction.options.getUser('user', true);
  const moderator = interaction.user;

  const logContext = {
    command: 'deny',
    applicantId: applicant.id,
    moderatorId: moderator.id,
    guildId: interaction.guildId,
  };

  if (!interaction.guild) {
    await interaction.reply({ embeds: [buildErrorEmbed('This command must be used in a server.')], ephemeral: false });
    return;
  }

  if (!apiService) {
    logger.error('ApiService unavailable for /deny', logContext);
    await interaction.reply({
      embeds: [buildErrorEmbed('Denial service unavailable. Please try again later.')],
      ephemeral: false,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: false });

  let response;
  try {
    response = await apiService.denyApplication({
      applicant_discord_id: applicant.id,
      moderator_discord_id: moderator.id,
    });
  } catch (error) {
    const { data, status } = error?.response ?? {};
    logger.warn('Nexus rejected /deny', { ...logContext, status, error: data ?? error?.message ?? error });

    const embed = buildErrorEmbed(data?.message ?? 'Unable to deny this application right now.', data?.error);
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  const config = response?.config ?? {};
  const application = response?.application ?? {};

  await handleRoleRemoval(interaction.guild, applicant.id, config, logger);
  await deleteInterviewChannel(interaction.guild, interaction.channel, application, logger);

  const successEmbed = new EmbedBuilder()
    .setTitle('Applicant Denied')
    .setColor(0xed4245)
    .setDescription(`${applicant} has been denied.`)
    .setTimestamp();

  await interaction.editReply({ embeds: [successEmbed] });
};

async function handleRoleRemoval(guild, applicantId, config, logger) {
  if (!config?.applicant_role_id) {
    return;
  }

  let member;
  try {
    member = await guild.members.fetch(applicantId);
  } catch (error) {
    logger.warn('Unable to fetch applicant for role removal', error?.message ?? error);
    return;
  }

  try {
    await member.roles.remove(config.applicant_role_id, 'Nexus AMS denial');
  } catch (error) {
    logger.warn('Failed to remove applicant role during denial', error?.message ?? error);
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
      await channel.delete('Nexus AMS application denied');
    } catch (error) {
      logger.warn('Failed to delete interview channel after denial', error?.message ?? error);
    }
  }
}

function buildErrorEmbed(message, errorCode) {
  const embed = new EmbedBuilder().setTitle('Denial Failed').setColor(0xed4245).setDescription(message).setTimestamp();

  if (errorCode) {
    embed.addFields({ name: 'Error', value: `\`${errorCode}\`` });
  }

  return embed;
}
