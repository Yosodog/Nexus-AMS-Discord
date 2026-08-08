import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder,
  SlashCommandBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import {
  actorFromInteraction, collectionMessage, deferEphemeral, executeAutocomplete,
  normalizeCollection, replyError,
} from '../utils/commandSupport.js';
import {
  buildEmbed,
  escapeMarkdown,
  formatDiscordTime,
  markdownLink,
  nationUrl,
  resolveDeepLink,
  statusLabel,
  statusMessage,
  truncate,
} from '../utils/discordUi.js';

export const data = new SlashCommandBuilder().setName('applications').setDescription('View and manage Nexus applications.')
  .addSubcommand((sub) => sub.setName('status').setDescription('View your application status.'))
  .addSubcommand((sub) => sub.setName('queue').setDescription('View the staff application queue.')
    .addStringOption((option) => option.setName('filter').setDescription('Queue filter').addChoices(
      { name: 'pending', value: 'pending' }, { name: 'stale', value: 'stale' },
    )))
  .addSubcommand((sub) => sub.setName('review').setDescription('Review an applicant or this application channel.')
    .addUserOption((option) => option.setName('applicant').setDescription('Applicant (defaults to current channel)')))
  .addSubcommand((sub) => sub.setName('approve').setDescription('Approve an application after confirmation.')
    .addStringOption((option) => option.setName('application').setDescription('Application').setRequired(true).setAutocomplete(true)))
  .addSubcommand((sub) => sub.setName('deny').setDescription('Deny an application with a reason.')
    .addStringOption((option) => option.setName('application').setDescription('Application').setRequired(true).setAutocomplete(true)))
  .setDMPermission(false);

export const help = Object.freeze({
  audience: 'Applicants and application staff',
  topic: Object.freeze(['applications', 'staff']),
  examples: Object.freeze(['/applications status', '/applications queue', '/applications review']),
  related: Object.freeze(['apply', 'approve', 'deny']),
});

const applicationChoices = async (interaction, apiService) => {
  const result = await apiService.getStaffApplications(actorFromInteraction(interaction), {
    query: interaction.options.getFocused()?.trim?.() ?? '', limit: 25,
  });
  return normalizeCollection(result).items.slice(0, 25).map((application) => ({
    name: `${application.label ?? application.leader_name ?? application.nation_name
      ?? application.applicant_name ?? application.discord_username ?? 'Application'}`.slice(0, 100),
    value: `${application.token ?? application.id}`.slice(0, 100),
  })).filter((choice) => choice.value && choice.value !== 'undefined' && choice.value !== 'null');
};
export const autocomplete = (interaction, { apiService }) => executeAutocomplete(interaction, apiService, applicationChoices);

const applicationIdentifier = (application) => `${
  typeof application === 'object' && application !== null
    ? application.token ?? application.id ?? ''
    : application ?? ''
}`.trim();

const applicationTarget = (application, fallback = undefined) => truncate(
  application?.leader_name
    ?? application?.nation_name
    ?? application?.applicant_name
    ?? application?.discord_username
    ?? fallback
    ?? (applicationIdentifier(application) ? `Application #${applicationIdentifier(application)}` : 'Selected application'),
  100,
);

const applicationLink = (application, baseUrl, fallbackTarget = undefined) => {
  const identifier = applicationIdentifier(application);
  const target = applicationTarget(application, fallbackTarget);
  const label = identifier && !target.includes(identifier)
    ? `${target} — Application #${identifier}`
    : target;
  const path = application?.deep_link_path
    ?? application?.url
    ?? (identifier ? `/admin/applications/${encodeURIComponent(identifier)}` : null);
  return markdownLink(label, resolveDeepLink(baseUrl, path));
};

const approvalConfirmation = (interaction, context, application, target = undefined) => {
  const reference = applicationLink(application, context.apiService.baseUrl, target);
  return statusMessage({
    title: 'Confirm Application Approval',
    tone: 'warning',
    description: `You are about to approve ${reference}. Nexus will revalidate your permissions and the application state when you confirm.`,
    footer: 'The decision will be recorded in Nexus.',
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(context.sessions.create({ commandName: 'applications', userId: interaction.user.id,
        event: 'approve-confirm', state: { application, target }, oneShot: true }))
        .setLabel('Approve application').setStyle(ButtonStyle.Success),
    )],
  });
};

const denialModal = (interaction, context, application, target = undefined) => {
  const reasonId = context.sessions.create({ commandName: 'applications', userId: interaction.user.id, event: 'field', oneShot: true });
  const modalId = context.sessions.create({ commandName: 'applications', userId: interaction.user.id,
    event: 'deny-reason', state: { application, reasonId, target }, oneShot: true });
  return new ModalBuilder().setCustomId(modalId).setTitle('Deny application')
    .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(reasonId)
      .setLabel('Reason').setMaxLength(500).setRequired(true).setStyle(TextInputStyle.Paragraph)));
};

const applicationReviewEmbed = (application, baseUrl, summary) => {
  const messages = Array.isArray(application?.messages) ? application.messages.slice(-3) : [];
  const submittedAt = application?.created_at;
  const fields = [
    {
      name: 'Application',
      value: applicationLink(application, baseUrl),
      inline: true,
    },
    application?.status ? { name: 'Status', value: statusLabel(application.status), inline: true } : null,
    submittedAt ? { name: 'Submitted', value: formatDiscordTime(submittedAt), inline: true } : null,
    application?.nation_id ? {
      name: 'Nation',
      value: markdownLink(`Nation #${application.nation_id}`, nationUrl({ id: application.nation_id })),
      inline: true,
    } : null,
    application?.discord_username || application?.discord_user_id ? {
      name: 'Discord Applicant',
      value: [
        application.discord_username ? escapeMarkdown(truncate(application.discord_username, 80)) : null,
        application.discord_user_id ? `<@${application.discord_user_id}>` : null,
      ].filter(Boolean).join(' · '),
      inline: true,
    } : null,
    messages.length ? {
      name: 'Recent Messages',
      value: messages.map((message) => {
        const author = escapeMarkdown(truncate(message.author ?? 'Applicant', 80));
        const sentAt = message.sent_at ? ` · ${formatDiscordTime(message.sent_at)}` : '';
        return `**${author}**${sentAt}\n${escapeMarkdown(truncate(message.content, 240))}`;
      }).join('\n\n'),
    } : null,
  ];

  return buildEmbed({
    title: `Application Review — ${applicationTarget(application)}`,
    tone: 'info',
    description: summary
      ? truncate(summary, 2_000)
      : 'Review the application details below before choosing an action. Nexus revalidates permissions and application state before recording a decision.',
    fields,
    url: resolveDeepLink(baseUrl, application?.deep_link_path ?? application?.url),
    footer: 'Use the controls below to continue the review.',
  });
};

export const execute = async (interaction, context) => {
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'deny') {
    await interaction.showModal(denialModal(
      interaction, context, interaction.options.getString('application', true),
    ));
    return;
  }
  await deferEphemeral(interaction);
  const actor = actorFromInteraction(interaction);
  try {
    if (subcommand === 'status') {
      const result = await context.apiService.getMyApplications(actor);
      await interaction.editReply(collectionMessage({
        title: 'Your Applications',
        collection: normalizeCollection(result),
        empty: 'No applications are linked to your Discord account yet.',
        description: 'Applications linked to your Discord account and their current Nexus status.',
        commandName: 'applications',
        userId: interaction.user.id,
        variant: 'application',
        sessions: context.sessions,
        baseUrl: context.apiService.baseUrl,
      }));
      return;
    }
    if (subcommand === 'queue') {
      const filter = interaction.options.getString('filter') ?? 'pending';
      const result = await context.apiService.getStaffApplications(actor, {
        filter,
      });
      await interaction.editReply(collectionMessage({
        title: 'Application Queue',
        collection: normalizeCollection(result),
        empty: filter === 'stale'
          ? 'No stale applications need attention.'
          : 'No pending applications are waiting for review.',
        description: filter === 'stale'
          ? 'Pending applications submitted at least seven days ago and awaiting staff attention.'
          : 'Pending applications awaiting staff review.',
        commandName: 'applications',
        userId: interaction.user.id,
        variant: 'application',
        sessions: context.sessions,
        baseUrl: context.apiService.baseUrl,
      }));
      return;
    }
    if (subcommand === 'review') {
      const applicant = interaction.options.getUser('applicant');
      const lookup = await context.apiService.getStaffApplications(actor, {
        applicant_discord_id: applicant?.id,
        discord_channel_id: applicant ? undefined : interaction.channelId,
        limit: 1,
      });
      const item = normalizeCollection(lookup).items[0];
      if (!item) throw Object.assign(new Error('No matching application was found.'), { code: 'NOT_FOUND' });
      const application = `${item.token ?? item.id}`;
      const result = await context.apiService.getStaffApplicationReview(actor, { application });
      const review = result?.application ?? result;
      const target = applicationTarget(review, applicationTarget(item));
      await interaction.editReply({
        embeds: [applicationReviewEmbed(review, context.apiService.baseUrl, result?.summary)],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(context.sessions.create({ commandName: 'applications', userId: interaction.user.id,
            event: 'approve-start', state: { application, target }, oneShot: true }))
            .setLabel('Approve').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(context.sessions.create({ commandName: 'applications', userId: interaction.user.id,
            event: 'deny-start', state: { application, target }, oneShot: true }))
            .setLabel('Deny').setStyle(ButtonStyle.Danger),
        )],
      });
      return;
    }
    await interaction.editReply(approvalConfirmation(
      interaction, context, interaction.options.getString('application', true),
    ));
  } catch (error) { await replyError(interaction, error); }
};

export const modal = async (interaction, context) => {
  const { application, reasonId, target } = context.session.state;
  const reason = interaction.fields.getTextInputValue(reasonId).trim();
  if (!reason) {
    await interaction.reply({
      ...statusMessage({
        title: 'Denial Reason Required',
        tone: 'danger',
        description: 'Enter a reason before denying this application.',
      }),
      ephemeral: true,
    });
    return;
  }
  const confirmId = context.sessions.create({ commandName: 'applications', userId: interaction.user.id,
    event: 'deny-confirm', state: { application, reason, target }, oneShot: true });
  const reference = applicationLink(application, context.apiService.baseUrl, target);
  await interaction.reply({
    ...statusMessage({
      title: 'Confirm Application Denial',
      tone: 'warning',
      description: `You are about to deny ${reference}. Nexus will revalidate your permissions and the application state when you confirm.`,
      fields: [{ name: 'Denial Reason', value: escapeMarkdown(truncate(reason, 500)) }],
      footer: 'The application and denial reason will be recorded in Nexus.',
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(confirmId).setLabel('Deny application').setStyle(ButtonStyle.Danger),
      )],
    }),
    ephemeral: true,
  });
};

export const button = async (interaction, context) => {
  if (context.session.event === 'deny-start') {
    await interaction.showModal(denialModal(
      interaction,
      context,
      context.session.state.application,
      context.session.state.target,
    ));
    return;
  }
  if (context.session.event === 'approve-start') {
    await interaction.update(approvalConfirmation(
      interaction,
      context,
      context.session.state.application,
      context.session.state.target,
    ));
    return;
  }
  await interaction.deferUpdate();
  const decision = context.session.event === 'approve-confirm' ? 'approve' : 'deny';
  try {
    const result = await context.apiService.decideStaffApplication(
      actorFromInteraction(interaction), context.session.state.application, decision,
      decision === 'deny' ? { reason: context.session.state.reason } : {},
    );
    const decidedApplication = result?.application ?? result;
    const outcome = decision === 'approve' ? 'approved' : 'denied';
    const reference = applicationLink(
      decidedApplication ?? context.session.state.application,
      context.apiService.baseUrl,
      context.session.state.target,
    );
    await interaction.editReply({
      content: null,
      ...statusMessage({
        title: decision === 'approve' ? 'Application Approved' : 'Application Denied',
        tone: decision === 'approve' ? 'success' : 'danger',
        description: result?.message
          ? truncate(result.message, 4_096)
          : `${reference} was ${outcome} in Nexus.`,
        fields: [
          decision === 'deny' && context.session.state.reason
            ? { name: 'Denial Reason', value: escapeMarkdown(truncate(context.session.state.reason, 500)) }
            : null,
          decidedApplication?.created_at
            ? { name: 'Submitted', value: formatDiscordTime(decidedApplication.created_at), inline: true }
            : null,
          decidedApplication?.status
            ? { name: 'Status', value: statusLabel(decidedApplication.status), inline: true }
            : null,
        ],
        timestamp: true,
      }),
      components: [],
    });
  } catch (error) { await replyError(interaction, error); }
};
