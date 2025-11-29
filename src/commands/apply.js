import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { slugify } from '../utils/slugify.js';

/**
 * /apply command to submit an application to Nexus AMS from Discord.
 * Creates an application, assigns applicant role, and spins up a private interview channel.
 */
export const data = new SlashCommandBuilder()
  .setName('apply')
  .setDescription('Submit an application to the Nexus AMS.')
  .addIntegerOption((option) =>
    option
      .setName('nationid')
      .setDescription('Your Politics & War nation ID.')
      .setRequired(true),
  )
  .setDMPermission(false);

/**
 * Execute handler for /apply.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction incoming command
 * @param {{ logger: import('../services/Logger.js').Logger, apiService: import('../services/ApiService.js').ApiService }} context shared dependencies
 */
export const execute = async (interaction, { logger, apiService }) => {
  const nationId = interaction.options.getInteger('nationid', true);
  const user = interaction.user;

  const logContext = { command: 'apply', nationId, userId: user.id, guildId: interaction.guildId };

  if (!interaction.guild) {
    await interaction.reply({
      embeds: [buildErrorEmbed('This command can only be used inside a server.')],
      ephemeral: false,
    });
    return;
  }

  if (!apiService) {
    logger.error('ApiService unavailable for /apply', logContext);
    await interaction.reply({
      embeds: [buildErrorEmbed('Application service is unavailable. Please try again later.')],
      ephemeral: false,
    });
    return;
  }

  if (!Number.isInteger(nationId) || nationId <= 0) {
    await interaction.reply({
      embeds: [buildErrorEmbed('Please provide a valid nation ID (positive whole number).')],
      ephemeral: false,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: false });

  let response;
  try {
    response = await apiService.createApplication({
      nation_id: nationId,
      discord_user_id: user.id,
      discord_username: user.tag ?? user.username,
    });
  } catch (error) {
    const { data, status } = error?.response ?? {};
    logger.warn('Nexus rejected /apply', { ...logContext, status, error: data ?? error?.message ?? error });

    const description = data?.message ?? 'Unable to submit your application right now.';
    const embed = buildErrorEmbed(description);

    if (data?.context?.join_url) {
      embed.addFields({ name: 'Join Link', value: data.context.join_url });
    }

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (!response?.application || !response?.config) {
    logger.warn('Unexpected /apply response shape', { ...logContext, response });
    await interaction.editReply({
      embeds: [buildErrorEmbed('Received an unexpected response from Nexus. Please contact staff.')],
    });
    return;
  }

  const application = response.application;
  const nation = response.nation ?? application?.nation ?? {};
  const config = response.config;
  const guild = interaction.guild;

  try {
    await assignApplicantRole(guild, user.id, config.applicant_role_id, logger);
  } catch (error) {
    // Proceed even if role assignment fails; notify applicant for transparency.
    logger.warn('Failed to assign applicant role', { ...logContext, error: error?.message ?? error });
  }

  let channel = null;
  try {
    channel = await createInterviewChannel({
      guild,
      applicantId: user.id,
      application,
      nation,
      config,
      botId: interaction.client.user.id,
      logger,
    });
  } catch (error) {
    logger.error('Failed to create interview channel', { ...logContext, error: error?.message ?? error });
    await interaction.editReply({
      embeds: [buildErrorEmbed('Application submitted, but failed to create the interview channel. Please contact staff.')],
    });
    return;
  }

  // Attach the channel to the application record for transcript correlation.
  try {
    await apiService.attachApplicationChannel({
      application_id: application.id ?? application.application_id ?? application.nexus_id ?? application.id,
      discord_channel_id: channel.id,
    });
  } catch (error) {
    logger.warn('Failed to attach channel to Nexus application', { ...logContext, error: error?.message ?? error });
  }

  await sendApplicationIntro(channel, application, nation, user.id, config);

  const confirmationEmbed = new EmbedBuilder()
    .setTitle('Application Submitted')
    .setColor(0x57f287)
    .setDescription(`Your application has been submitted. Please continue in ${channel}.`)
    .addFields({ name: 'Channel', value: `${channel}` })
    .setTimestamp();

  await interaction.editReply({ embeds: [confirmationEmbed] });
};

/**
 * Assign the applicant role to the applicant if the role exists and is reachable.
 */
async function assignApplicantRole(guild, userId, roleId, logger) {
  if (!roleId) {
    logger.warn('Applicant role id missing; skipping role assignment.');
    return;
  }

  const member = await guild.members.fetch(userId);
  await member.roles.add(roleId, 'Nexus application applicant role');
}

/**
 * Create a private interview channel with restrictive permissions.
 */
async function createInterviewChannel({ guild, applicantId, application, nation, config, botId, logger }) {
  const leaderName =
    nation?.leader_name ??
    application?.leader_name ??
    application?.leader_name_snapshot ??
    application?.leader ??
    application?.nation?.leader_name ??
    application?.nation_leader;
  const slug = slugify(leaderName ?? 'applicant');

  const applicationId = application?.id ?? application?.application_id ?? application?.nexus_id ?? 0;
  const nationId = nation?.id ?? application?.nation_id ?? application?.nation?.id ?? application?.nation?.nation_id ?? 0;

  const channelName = `app-${applicationId ?? 'new'}-${nationId ?? 'na'}-${slug}`;

  const permissionOverwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: applicantId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ],
    },
    {
      id: botId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ],
    },
  ];

  if (config?.ia_role_id) {
    permissionOverwrites.push({
      id: config.ia_role_id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ManageMessages,
      ],
    });
  }

  logger.info('Creating interview channel', { channelName, applicantId });

  return guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    reason: 'Nexus AMS application interview channel',
    permissionOverwrites,
    parent: config?.interview_category_id ?? undefined,
  });
}

/**
 * Send initial embed and ping in the interview channel.
 */
async function sendApplicationIntro(channel, application, nation, applicantId, config) {
  const nationId = nation?.id ?? application?.nation_id ?? application?.nation?.id ?? 'Unknown';
  const nationName = nation?.nation_name ?? application?.nation_name ?? application?.nation?.name ?? 'Unknown Nation';
  const leaderName =
    nation?.leader_name ??
    application?.leader_name ??
    application?.leader_name_snapshot ??
    application?.leader ??
    application?.nation?.leader_name ??
    'Applicant';
  const link =
    application?.links?.nation ??
    application?.nation?.links?.nation ??
    `https://politicsandwar.com/nation/id=${nationId}`;

  const allianceName =
    nation?.alliance?.name ??
    (nation?.alliance_id ? `Alliance #${nation.alliance_id}` : null) ??
    application?.alliance_name ??
    null;
  const score = nation?.score ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(nation.score) : null;
  const cities = nation?.num_cities ?? nation?.cities ?? null;

  const embed = new EmbedBuilder()
    .setTitle('New Application')
    .setColor(0x5865f2)
    .setDescription(`${leaderName} (${nationName}) has submitted an application.`)
    .setTimestamp();

  embed.addFields(
    { name: 'Nation', value: `[${nationName}](${link})`, inline: true },
    { name: 'Leader', value: leaderName, inline: true },
    { name: 'Nation ID', value: String(nationId), inline: true },
  );

  if (allianceName) {
    embed.addFields({ name: 'Alliance', value: allianceName, inline: true });
  }

  if (cities !== null) {
    embed.addFields({ name: 'Cities', value: String(cities), inline: true });
  }

  if (score) {
    embed.addFields({ name: 'Score', value: score, inline: true });
  }

  if (nation?.flag) {
    embed.setThumbnail(nation.flag);
  }

  await channel.send({ embeds: [embed] });
  await channel.send({
    content: `<@${applicantId}> ${config?.ia_role_id ? `<@&${config.ia_role_id}> ` : ''}Please standby, a member of the team will assist you shortly.`,
  });
}

function buildErrorEmbed(message) {
  return new EmbedBuilder().setTitle('Application Error').setColor(0xed4245).setDescription(message).setTimestamp();
}
