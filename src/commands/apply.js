import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
} from 'discord.js';
import { isDiscordSnowflake } from '../utils/boundaryValidators.js';
import {
  actorFromInteraction,
  deferEphemeral,
  replyError,
} from '../utils/commandSupport.js';
import { config as runtimeConfig } from '../utils/config.js';
import {
  buildEmbed,
  escapeMarkdown,
  formatDiscordTime,
  resolveDeepLink,
  statusMessage,
  truncate,
} from '../utils/discordUi.js';

export const data = new SlashCommandBuilder()
  .setName('apply')
  .setDescription('Submit or continue a Nexus application.')
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
  related: Object.freeze(['applications', 'me', 'verify']),
});

export const execute = async (
  interaction,
  {
    logger,
    apiService,
    sessions,
    guildId = runtimeConfig.discord.guildId,
  },
) => {
  const nationId = interaction.options.getInteger('nationid', true);
  if (!interaction.guild || !guildId || interaction.guildId !== guildId) {
    await interaction.reply({
      ...statusMessage({
        title: 'Application Unavailable',
        tone: 'warning',
        description: 'Use this command inside a Discord server connected to Nexus.',
      }),
      ephemeral: true,
    });
    return;
  }

  await deferEphemeral(interaction);
  try {
    if (!apiService || !sessions) {
      throw new TypeError('The Nexus application service is unavailable.');
    }
    if (!Number.isSafeInteger(nationId) || nationId <= 0) {
      throw new TypeError('Provide a valid positive nation ID.');
    }

    const actor = actorFromInteraction(interaction, 'apply');
    const preview = await apiService.previewApplication(actor, {
      nation_id: nationId,
      discord_username: interaction.user.globalName
        ?? interaction.user.tag
        ?? interaction.user.username,
    });
    const intentId = `${preview?.intent?.id ?? ''}`;
    if (!/^[a-zA-Z0-9]{64}$/.test(intentId)) {
      throw new TypeError('Nexus returned an invalid application confirmation token.');
    }

    const confirmId = sessions.create({
      commandName: 'apply',
      userId: interaction.user.id,
      event: 'confirm',
      state: { intentId },
      oneShot: true,
    });
    const nation = preview?.summary?.nation ?? {};
    const continuesExisting = preview?.summary?.continues_existing_application === true;
    const warnings = Array.isArray(preview?.warnings)
      ? preview.warnings.filter((value) => typeof value === 'string' && value.trim() !== '')
      : [];

    await interaction.editReply({
      embeds: [buildEmbed({
        title: continuesExisting ? 'Review Application Continuation' : 'Review Application',
        tone: 'warning',
        description: truncate(
          preview?.summary?.description
            ?? 'Nexus validated this application. Confirm to submit it.',
          1_200,
        ),
        fields: [
          nation.id
            ? { name: 'Nation', value: `#${nation.id}`, inline: true }
            : { name: 'Nation', value: `#${nationId}`, inline: true },
          nation.name
            ? { name: 'Name', value: escapeMarkdown(truncate(nation.name, 100)), inline: true }
            : null,
          nation.leader_name
            ? { name: 'Leader', value: escapeMarkdown(truncate(nation.leader_name, 100)), inline: true }
            : null,
          {
            name: 'Action',
            value: continuesExisting ? 'Continue pending application' : 'Submit new application',
            inline: true,
          },
          preview?.intent?.expires_at
            ? { name: 'Confirmation expires', value: formatDiscordTime(preview.intent.expires_at), inline: true }
            : null,
          warnings.length > 0
            ? { name: 'Nexus guidance', value: truncate(warnings.join('\n'), 1_000), inline: false }
            : null,
        ],
        url: resolveDeepLink(apiService.baseUrl, preview?.deep_link_path),
        footer: 'Nexus will revalidate eligibility and installation capabilities when you confirm.',
      })],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(confirmId)
          .setLabel(continuesExisting ? 'Continue application' : 'Submit application')
          .setStyle(ButtonStyle.Success),
      )],
    });
  } catch (error) {
    logger?.warn?.('Nexus rejected /apply preview', {
      command: 'apply',
      guildId: interaction.guildId,
      userId: interaction.user.id,
      nationId,
      errorCode: error?.code ?? null,
      status: error?.status ?? null,
    });
    await replyError(interaction, error, 'Application Preview Failed');
  }
};

export const button = async (interaction, context) => {
  await interaction.deferUpdate();
  try {
    if (context.session?.event !== 'confirm') {
      throw new TypeError('This application control is no longer supported.');
    }
    const intentId = `${context.session?.state?.intentId ?? ''}`;
    if (!/^[a-zA-Z0-9]{64}$/.test(intentId)) {
      throw new TypeError('This application confirmation is invalid or expired.');
    }

    const result = await context.apiService.confirmApplication(
      actorFromInteraction(interaction, 'apply'),
      { intent_id: intentId },
    );
    const application = result?.application;
    if (!application?.id || !application?.nation_id || !application?.status) {
      throw new TypeError('Nexus returned an invalid application result.');
    }

    const reconciliation = result?.reconciliation ?? {};
    const channelHealth = result?.channel_health ?? {};
    const channelId = channelHealth.state === 'ready' && isDiscordSnowflake(channelHealth.channel_id)
      ? channelHealth.channel_id
      : null;
    const needsAttention = reconciliation.state === 'attention'
      || channelHealth.state === 'attention';
    const setupPending = ['queued', 'in_progress'].includes(reconciliation.state)
      || channelHealth.state === 'preparing';
    const title = application.continues_existing_application
      ? 'Application Continued'
      : 'Application Submitted';
    const description = channelId
      ? `Your private interview channel is ready: <#${channelId}>.`
      : needsAttention
        ? 'Your application is saved in Nexus, but Discord follow-up needs staff attention.'
        : setupPending
          ? 'Your application is saved. Nexus is preparing the private Discord follow-up.'
          : 'Your application is saved in Nexus. Use the link below to continue.';

    await interaction.editReply(statusMessage({
      title: needsAttention ? `${title} — Setup Needs Attention` : title,
      tone: needsAttention ? 'warning' : 'success',
      description,
      fields: [
        { name: 'Application', value: `#${application.id}`, inline: true },
        { name: 'Nation', value: `#${application.nation_id}`, inline: true },
        { name: 'Status', value: escapeMarkdown(truncate(application.status, 100)), inline: true },
        reconciliation.label
          ? { name: 'Discord follow-up', value: truncate(reconciliation.label, 300), inline: false }
          : null,
        application.created_at
          ? { name: 'Submitted', value: formatDiscordTime(application.created_at), inline: true }
          : null,
      ],
      url: resolveDeepLink(context.apiService.baseUrl, result?.deep_link_path),
      footer: needsAttention
        ? 'Nexus recorded the issue so application staff can repair the Discord setup.'
        : null,
      timestamp: true,
    }));
  } catch (error) {
    context.logger?.warn?.('Nexus rejected /apply confirmation', {
      command: 'apply',
      guildId: interaction.guildId,
      userId: interaction.user.id,
      errorCode: error?.code ?? null,
      status: error?.status ?? null,
    });
    await replyError(interaction, error, 'Application Submission Failed');
  }
};
