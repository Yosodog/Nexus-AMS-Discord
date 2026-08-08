import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder,
  SlashCommandBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import {
  actorFromInteraction, collectionMessage, deferEphemeral, executeAutocomplete,
  normalizeCollection, replyError,
} from '../utils/commandSupport.js';
import { isDiscordSnowflake } from '../utils/boundaryValidators.js';
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

const sameOriginApplicationUrl = (baseUrl, path) => {
  const resolved = resolveDeepLink(baseUrl, path);
  if (!resolved) return null;
  try {
    return new URL(resolved).origin === new URL(baseUrl).origin ? resolved : null;
  } catch {
    return null;
  }
};

const applicationStatusValue = (application, baseUrl) => {
  const facts = Array.isArray(application?.progress?.facts)
    ? application.progress.facts.slice(0, 8)
    : [];
  const blockers = Array.isArray(application?.progress?.blockers)
    ? application.progress.blockers.slice(0, 2)
    : [];
  const channel = application?.channel_health;
  const reconciliation = application?.reconciliation;
  const lines = [
    application?.created_at ? `Submitted: ${formatDiscordTime(application.created_at)}` : null,
    ...facts.map((fact) => (
      typeof fact?.complete === 'boolean' && typeof fact?.label === 'string'
        ? `${fact.complete ? '✓' : '○'} ${escapeMarkdown(truncate(fact.label, 160))}`
        : null
    )),
    channel?.label && typeof channel.label === 'string'
      ? `**Discord:** ${escapeMarkdown(truncate(channel.label, 240))}`
      : null,
    channel?.state === 'ready' && isDiscordSnowflake(channel?.channel_id)
      ? `Channel: <#${channel.channel_id}>`
      : null,
    reconciliation?.label && typeof reconciliation.label === 'string'
      ? `**Reconciliation:** ${escapeMarkdown(truncate(reconciliation.label, 240))}`
      : null,
    ...blockers.map((blocker) => (
      typeof blocker?.message === 'string'
        ? `**What needs attention:** ${escapeMarkdown(truncate(blocker.message, 500))}`
        : null
    )),
  ].filter(Boolean);
  const nextAction = application?.progress?.next_action;
  const nextUrl = sameOriginApplicationUrl(baseUrl, nextAction?.deep_link_path);
  if (nextUrl && typeof nextAction?.label === 'string') {
    lines.push(markdownLink(truncate(nextAction.label, 100), nextUrl));
  } else {
    const fallbackUrl = sameOriginApplicationUrl(baseUrl, application?.deep_link_path);
    if (fallbackUrl) lines.push(markdownLink('Open application in Nexus', fallbackUrl));
  }
  if (application?.updated_at) lines.push(`Updated: ${formatDiscordTime(application.updated_at)}`);

  return truncate(lines.join('\n'), 1_024, 'No application progress is available.');
};

const applicationStatusMessage = (result, baseUrl) => {
  const collection = normalizeCollection(result);
  const applications = collection.items.slice(0, 5);
  const hasProjection = applications.some((application) => (
    application?.progress && application?.channel_health && application?.reconciliation
  ));
  if (!hasProjection) return null;

  const firstAction = applications
    .map((application) => application?.progress?.next_action)
    .find((action) => sameOriginApplicationUrl(baseUrl, action?.deep_link_path));
  const firstActionUrl = sameOriginApplicationUrl(baseUrl, firstAction?.deep_link_path);
  const components = firstActionUrl && typeof firstAction?.label === 'string'
    ? [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel(truncate(firstAction.label, 80))
        .setStyle(ButtonStyle.Link)
        .setURL(firstActionUrl),
    )]
    : [];

  return {
    embeds: [buildEmbed({
      title: 'Your Applications',
      tone: 'info',
      description: applications.length
        ? 'Nexus-calculated application progress, Discord follow-up, and next steps.'
        : 'No applications are linked to your Discord account yet.',
      fields: applications.map((application, index) => ({
        name: `Application #${application?.id ?? index + 1}${
          application?.status ? ` · ${statusLabel(application.status)}` : ''
        }`,
        value: applicationStatusValue(application, baseUrl),
      })),
      footer: applications.length < collection.total
        ? `Showing ${applications.length} of ${collection.total} applications.`
        : null,
    })],
    components,
    allowedMentions: { parse: [] },
  };
};

const decisionSelection = ({ application, applicantDiscordId, target } = {}) => {
  const selectedApplication = applicationIdentifier(application);
  const selectedApplicant = `${applicantDiscordId ?? ''}`.trim();
  const hasSelectedApplicant = /^\d{17,20}$/.test(selectedApplicant);
  if (!selectedApplication && !hasSelectedApplicant) {
    throw new TypeError('An application or applicant Discord user is required.');
  }
  return {
    ...(selectedApplication ? { application } : {}),
    ...(hasSelectedApplicant ? { applicantDiscordId: selectedApplicant } : {}),
    ...(target ? { target: truncate(target, 100) } : {}),
  };
};

export const approvalConfirmation = (interaction, context, selection) => {
  const state = decisionSelection(selection);
  const reference = applicationLink(state.application, context.apiService.baseUrl, state.target);
  return statusMessage({
    title: 'Confirm Application Approval',
    tone: 'warning',
    description: `You are about to approve ${reference}. Nexus will revalidate your permissions and the application state when you confirm.`,
    footer: 'The decision will be recorded in Nexus.',
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(context.sessions.create({ commandName: 'applications', userId: interaction.user.id,
        event: 'approve-confirm', state, oneShot: true }))
        .setLabel('Approve application').setStyle(ButtonStyle.Success),
    )],
  });
};

export const denialModal = (interaction, context, selection) => {
  const state = decisionSelection(selection);
  const reasonId = context.sessions.create({ commandName: 'applications', userId: interaction.user.id, event: 'field', oneShot: true });
  const modalId = context.sessions.create({ commandName: 'applications', userId: interaction.user.id,
    event: 'deny-reason', state: { ...state, reasonId }, oneShot: true });
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
      interaction,
      context,
      { application: interaction.options.getString('application', true) },
    ));
    return;
  }
  await deferEphemeral(interaction);
  const actor = actorFromInteraction(interaction);
  try {
    if (subcommand === 'status') {
      const result = await context.apiService.getMyApplications(actor);
      const enhanced = applicationStatusMessage(result, context.apiService.baseUrl);
      await interaction.editReply(enhanced ?? collectionMessage({
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
            event: 'approve-start', state: decisionSelection({ application, target }), oneShot: true }))
            .setLabel('Approve').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(context.sessions.create({ commandName: 'applications', userId: interaction.user.id,
            event: 'deny-start', state: decisionSelection({ application, target }), oneShot: true }))
            .setLabel('Deny').setStyle(ButtonStyle.Danger),
        )],
      });
      return;
    }
    await interaction.editReply(approvalConfirmation(
      interaction,
      context,
      { application: interaction.options.getString('application', true) },
    ));
  } catch (error) { await replyError(interaction, error); }
};

export const modal = async (interaction, context) => {
  const { reasonId, ...selection } = context.session.state;
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
    event: 'deny-confirm', state: { ...decisionSelection(selection), reason }, oneShot: true });
  const reference = applicationLink(selection.application, context.apiService.baseUrl, selection.target);
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
      context.session.state,
    ));
    return;
  }
  if (context.session.event === 'approve-start') {
    await interaction.update(approvalConfirmation(
      interaction,
      context,
      context.session.state,
    ));
    return;
  }
  if (!['approve-confirm', 'deny-confirm'].includes(context.session.event)) {
    await replyError(interaction, Object.assign(new Error('This application control is no longer valid.'), {
      code: 'VALIDATION_ERROR',
    }));
    return;
  }
  await interaction.deferUpdate();
  const decision = context.session.event === 'approve-confirm' ? 'approve' : 'deny';
  try {
    let application = context.session.state.application;
    let target = context.session.state.target;
    if (!applicationIdentifier(application)) {
      const lookup = await context.apiService.getStaffApplications(
        actorFromInteraction(interaction, 'applications'),
        {
          applicant_discord_id: context.session.state.applicantDiscordId,
          filter: 'pending',
          limit: 2,
        },
      );
      const matches = normalizeCollection(lookup).items;
      if (matches.length === 0) {
        throw Object.assign(new Error('No pending application was found for that Discord user.'), {
          code: 'NOT_FOUND',
        });
      }
      if (matches.length > 1) {
        throw Object.assign(new Error('More than one pending application matched that Discord user. Review it with /applications.'), {
          code: 'VALIDATION_ERROR',
        });
      }
      application = matches[0];
      target = applicationTarget(application, target);
    }
    const identifier = applicationIdentifier(application);
    if (!identifier) {
      throw Object.assign(new Error('Nexus did not return a usable application reference.'), {
        code: 'VALIDATION_ERROR',
      });
    }
    const result = await context.apiService.decideStaffApplication(
      actorFromInteraction(interaction, 'applications'), identifier, decision,
      decision === 'deny' ? { reason: context.session.state.reason } : {},
    );
    const decidedApplication = result?.application ?? result;
    const outcome = decision === 'approve' ? 'approved' : 'denied';
    const reference = applicationLink(
      decidedApplication ?? application,
      context.apiService.baseUrl,
      target,
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
