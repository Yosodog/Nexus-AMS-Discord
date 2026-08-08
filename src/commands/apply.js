import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import {
  buildApplicationChannelTopic,
  resolveApplicationIdentity,
  validateApplicationInterviewChannel,
} from '../utils/applicationChannels.js';
import { isDiscordSnowflake } from '../utils/boundaryValidators.js';
import { config as runtimeConfig } from '../utils/config.js';
import {
  buildEmbed,
  escapeMarkdown,
  formatDiscordTime,
  formatNumber,
  markdownLink,
  nationUrl,
  safeUrl,
  statusMessage,
  truncate,
} from '../utils/discordUi.js';
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

export const help = Object.freeze({
  audience: 'Applicants',
  topic: Object.freeze(['applications']),
  examples: Object.freeze(['/apply nationid:<nation-id>']),
  related: Object.freeze(['applications', 'verify']),
});

/**
 * Execute handler for /apply.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction incoming command
 * @param {{ logger: import('../services/Logger.js').Logger, apiService: import('../services/ApiService.js').ApiService }} context shared dependencies
 */
export const execute = async (
  interaction,
  { logger, apiService, guildId = runtimeConfig.discord.guildId },
) => {
  const nationId = interaction.options.getInteger('nationid', true);
  const user = interaction.user;

  const logContext = { command: 'apply', nationId, userId: user.id, guildId: interaction.guildId };

  if (!interaction.guild || !guildId || interaction.guildId !== guildId) {
    await interaction.reply({
      embeds: [buildErrorEmbed('This command can only be used inside a server.')],
      ephemeral: true,
    });
    return;
  }

  if (!apiService) {
    logger.error('ApiService unavailable for /apply', logContext);
    await interaction.reply({
      embeds: [buildErrorEmbed('Application service is unavailable. Please try again later.')],
      ephemeral: true,
    });
    return;
  }

  if (!Number.isInteger(nationId) || nationId <= 0) {
    await interaction.reply({
      embeds: [buildErrorEmbed('Please provide a valid nation ID (positive whole number).')],
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  let response;
  try {
    response = await apiService.createApplication({
      nation_id: nationId,
      discord_user_id: user.id,
      discord_username: user.tag ?? user.username,
    });
  } catch (error) {
    const { data, status } = error?.response ?? {};
    logger.warn('Nexus rejected /apply', {
      ...logContext,
      status: status ?? null,
      backendErrorCode: data?.error ?? null,
      backendMessage: data?.message ?? error?.message ?? null,
    });

    const description = data?.message ?? 'Unable to submit your application right now.';
    const embed = buildErrorEmbed(description, data?.context?.join_url ? [{
      name: 'Required Server',
      value: markdownLink('Open the Discord invite', data.context.join_url),
    }] : []);

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (!response?.application || !response?.config) {
    logger.warn('Unexpected /apply response shape', {
      ...logContext,
      hasApplication: Boolean(response?.application),
      hasConfig: Boolean(response?.config),
    });
    await interaction.editReply({
      embeds: [buildErrorEmbed('Received an unexpected response from Nexus. Please contact staff.')],
    });
    return;
  }

  const application = response.application;
  const nation = response.nation ?? application?.nation ?? {};
  const config = response.config;
  const guild = interaction.guild;
  const setupIssues = [];

  const roleResult = await assignApplicantRole(guild, user.id, config.applicant_role_id, logger);
  if (!roleResult.success) {
    setupIssues.push(roleResult.reason);
  }

  let channel = null;
  try {
    const channelResult = await resolveOrCreateInterviewChannel({
      guild,
      guildId,
      applicantId: user.id,
      application,
      nation,
      config,
      botId: interaction.client.user.id,
      logger,
    });
    channel = channelResult.channel;
  } catch (error) {
    logger.error('Failed to resolve interview channel', {
      ...logContext,
      errorMessage: error?.message ?? String(error),
    });
    await interaction.editReply({
      embeds: [buildPartialEmbed('Your application was submitted in Nexus, but Discord setup is pending. Staff must resolve the interview channel before setup can continue.')],
    });
    return;
  }

  // Attach the channel to the application record for transcript correlation.
  if (`${application.discord_channel_id ?? ''}` !== channel.id) {
    try {
      const identity = resolveApplicationIdentity(application, nation);
      await apiService.attachApplicationChannel({
        application_id: identity.applicationId,
        discord_channel_id: channel.id,
      });
      application.discord_channel_id = channel.id;
    } catch (error) {
      logger.warn('Failed to attach channel to Nexus application', {
        ...logContext,
        errorMessage: error?.message ?? null,
      });
      await interaction.editReply({
        embeds: [
          buildPartialEmbed(
            `Your application was submitted in Nexus and the interview channel ${channel} is ready in Discord, but Nexus could not attach it. Do not use the channel until staff complete setup.`,
          ),
        ],
      });
      return;
    }
  }

  try {
    await sendApplicationIntro(channel, application, nation, user.id, config);
  } catch (error) {
    logger.warn('Failed to send application introduction', {
      ...logContext,
      errorMessage: error?.message ?? String(error),
    });
    setupIssues.push('intro_send_failed');
  }

  const setupPending = setupIssues.length > 0;
  const identity = resolveApplicationIdentity(application, nation);
  const nationIdForLink = nation?.id ?? application?.nation_id;
  await interaction.editReply(statusMessage({
    title: setupPending ? 'Application Submitted — Setup Pending' : 'Application Submitted',
    tone: setupPending ? 'warning' : 'success',
    description: setupPending
      ? `Your application was submitted in Nexus and your interview channel is ${channel}, but some Discord setup is pending. Staff have been asked to review it.`
      : `Your application has been submitted. Please continue in ${channel}.`,
    fields: [
      { name: 'Interview Channel', value: `${channel}`, inline: true },
      identity?.applicationId
        ? { name: 'Application', value: `#${identity.applicationId}`, inline: true }
        : null,
      nationIdForLink
        ? {
          name: 'Nation',
          value: markdownLink(`Nation #${nationIdForLink}`, nationUrl({ id: nationIdForLink })),
          inline: true,
        }
        : null,
      application?.created_at
        ? { name: 'Submitted', value: formatDiscordTime(application.created_at), inline: true }
        : null,
    ],
    footer: setupPending ? 'Your Nexus application is saved; staff will finish the Discord setup.' : null,
    timestamp: true,
  }));
};

/**
 * Assign the applicant role to the applicant if the role exists and is reachable.
 */
async function assignApplicantRole(guild, userId, roleId, logger) {
  if (!isDiscordSnowflake(roleId)) {
    logger.warn('Applicant role id missing or invalid; skipping role assignment.');
    return { success: false, reason: 'invalid_applicant_role' };
  }

  try {
    const member = await guild.members.fetch(userId);
    if (!member.roles.cache?.has?.(roleId)) {
      await member.roles.add(roleId, 'Nexus application applicant role');
    }
    return { success: true };
  } catch (error) {
    logger.warn('Failed to assign applicant role', {
      errorMessage: error?.message ?? String(error),
    });
    return { success: false, reason: 'applicant_role_add_failed' };
  }
}

/**
 * Resolve a persisted/recoverable interview channel before creating anything.
 * Ambiguous matches fail closed so a retry cannot create or mutate the wrong room.
 */
async function resolveOrCreateInterviewChannel(options) {
  const { guild, guildId, application, nation, logger } = options;
  const identity = resolveApplicationIdentity(application, nation);
  if (!identity) {
    throw new Error('Nexus application response is missing a stable application or nation id.');
  }

  const attachedChannelId = `${application?.discord_channel_id ?? ''}`.trim();
  if (attachedChannelId) {
    if (!isDiscordSnowflake(attachedChannelId)) {
      throw new Error('Nexus returned an invalid interview channel id.');
    }

    const channel = await guild.channels.fetch(attachedChannelId);
    const validation = validateApplicationInterviewChannel({
      channel,
      application,
      nation,
      guildId,
    });
    if (!validation.valid) {
      throw new Error(`Attached interview channel failed validation: ${validation.reason}`);
    }

    return { channel, reused: true, source: 'attached' };
  }

  let channels;
  try {
    channels = await guild.channels.fetch();
  } catch (error) {
    logger.warn('Unable to list guild channels for application recovery', {
      errorMessage: error?.message ?? String(error),
    });
    throw new Error('Unable to verify whether an interview channel already exists.');
  }

  const candidates = Array.from(channels?.values?.() ?? []).filter((channel) =>
    validateApplicationInterviewChannel({
      channel,
      application,
      nation,
      guildId,
    }).valid,
  );

  if (candidates.length > 1) {
    throw new Error('Multiple matching interview channels require manual resolution.');
  }

  if (candidates.length === 1) {
    logger.info('Reusing verified interview channel', {
      applicationId: identity.applicationId,
      channelId: candidates[0].id,
    });
    return { channel: candidates[0], reused: true, source: 'recovered' };
  }

  const channel = await createInterviewChannel(options);
  return { channel, reused: false, source: 'created' };
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

  const identity = resolveApplicationIdentity(application, nation);
  if (!identity) {
    throw new Error('Cannot create an interview channel without application and nation ids.');
  }
  const { applicationId, nationId } = identity;

  if (!isDiscordSnowflake(applicantId) || !isDiscordSnowflake(botId)) {
    throw new Error('Cannot create an interview channel with invalid Discord user ids.');
  }

  const channelName = `app-${applicationId}-${nationId}-${slug}`;
  const topic = buildApplicationChannelTopic(applicationId, nationId);

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

  if (config?.ia_role_id && !isDiscordSnowflake(config.ia_role_id)) {
    throw new Error('Nexus returned an invalid IA role id.');
  }

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
    topic,
    type: ChannelType.GuildText,
    reason: 'Nexus AMS application interview channel',
    permissionOverwrites,
    parent: isDiscordSnowflake(config?.interview_category_id)
      ? config.interview_category_id
      : undefined,
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
  const score = nation?.score ? formatNumber(nation.score, { maximumFractionDigits: 2 }) : null;
  const cities = nation?.num_cities ?? nation?.cities ?? null;
  const nationLink = nationUrl({ ...nation, id: nationId, nation_url: link });
  const embed = buildEmbed({
    title: 'New Application',
    tone: 'info',
    description: `${escapeMarkdown(truncate(leaderName, 100))} (${escapeMarkdown(truncate(nationName, 100))}) has submitted an application.`,
    fields: [
      { name: 'Nation', value: markdownLink(truncate(nationName, 100), nationLink), inline: true },
      { name: 'Leader', value: escapeMarkdown(truncate(leaderName, 100)), inline: true },
      { name: 'Nation ID', value: String(nationId), inline: true },
      allianceName ? { name: 'Alliance', value: escapeMarkdown(truncate(allianceName, 100)), inline: true } : null,
      cities !== null ? { name: 'Cities', value: String(cities), inline: true } : null,
      score ? { name: 'Score', value: score, inline: true } : null,
      application?.created_at
        ? { name: 'Submitted', value: formatDiscordTime(application.created_at), inline: true }
        : null,
    ],
    url: nationLink,
    timestamp: true,
  });

  const flagUrl = safeUrl(nation?.flag);
  if (flagUrl) embed.setThumbnail(flagUrl);

  const identity = resolveApplicationIdentity(application, nation);
  const embedNonce = `nxa${identity.applicationId}intro`.slice(0, 25);
  const mentionNonce = `nxa${identity.applicationId}ping`.slice(0, 25);
  const iaRoleId = isDiscordSnowflake(config?.ia_role_id) ? config.ia_role_id : null;

  await channel.send({
    embeds: [embed],
    nonce: embedNonce,
    enforceNonce: true,
    allowedMentions: { parse: [], repliedUser: false },
  });
  await channel.send({
    content: `<@${applicantId}> ${iaRoleId ? `<@&${iaRoleId}> ` : ''}Please standby, a member of the team will assist you shortly.`,
    nonce: mentionNonce,
    enforceNonce: true,
    allowedMentions: {
      parse: [],
      users: [applicantId],
      roles: iaRoleId ? [iaRoleId] : [],
      repliedUser: false,
    },
  });
}

function buildErrorEmbed(message, fields = []) {
  return buildEmbed({
    title: 'Application Error',
    tone: 'danger',
    description: truncate(message, 4_096),
    fields,
    timestamp: true,
  });
}

function buildPartialEmbed(message) {
  return buildEmbed({
    title: 'Application Submitted — Setup Pending',
    tone: 'warning',
    description: truncate(message, 4_096),
    footer: 'Your Nexus application is saved; staff will finish the Discord setup.',
    timestamp: true,
  });
}
