import { ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder } from 'discord.js';
import {
  actorFromInteraction, collectionMessage, deferEphemeral, normalizeCollection, replyError,
} from '../utils/commandSupport.js';
import {
  escapeMarkdown, formatDiscordTime, markdownLink, resolveDeepLink, statusLabel,
  statusMessage, statusTone, truncate,
} from '../utils/discordUi.js';

export const data = new SlashCommandBuilder()
  .setName('audit')
  .setDescription('Review and manage your active Nexus audit findings.')
  .addSubcommand((subcommand) => subcommand.setName('status').setDescription('View your active audit findings.'))
  .addSubcommand((subcommand) => subcommand.setName('explain').setDescription('Explain an audit finding and how to correct it.')
    .addStringOption((option) => option.setName('finding').setDescription('Audit finding').setRequired(true).setAutocomplete(true)))
  .addSubcommand((subcommand) => subcommand.setName('acknowledge').setDescription('Acknowledge an audit finding.')
    .addIntegerOption((option) => option.setName('finding').setDescription('Audit finding ID').setRequired(true).setMinValue(1))
    .addStringOption((option) => option.setName('note').setDescription('Optional remediation note').setMaxLength(500)))
  .addSubcommand((subcommand) => subcommand.setName('snooze').setDescription('Snooze Discord reminders for a finding.')
    .addIntegerOption((option) => option.setName('finding').setDescription('Audit finding ID').setRequired(true).setMinValue(1))
    .addIntegerOption((option) => option.setName('hours').setDescription('Snooze duration in hours').setRequired(true)
      .addChoices(
        { name: '1 day', value: 24 },
        { name: '3 days', value: 72 },
        { name: '7 days', value: 168 },
      )))
  .setDMPermission(false);

export const help = Object.freeze({
  audience: 'Members and staff',
  topic: Object.freeze(['member', 'staff']),
  examples: Object.freeze([
    '/audit status',
    '/audit explain finding:<finding>',
    '/audit acknowledge finding:<finding> note:<note>',
    '/audit snooze finding:<finding> hours:<hours>',
  ]),
  related: Object.freeze(['requests', 'help']),
});

const findingId = (finding) => finding?.id ?? finding?.audit_result_id ?? finding?.finding_id;

const findingName = (finding) => finding?.name ?? 'Audit finding';

const textValue = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object') return null;
  return String(value);
};

const evidenceLines = (evidence) => {
  if (!Array.isArray(evidence) || evidence.length === 0) return [];

  return evidence.slice(0, 8).map((entry, index) => {
    if (!entry || typeof entry !== 'object') return `${index + 1}. ${textValue(entry) ?? 'Evidence recorded.'}`;

    const label = textValue(entry.field_label ?? entry.condition ?? entry.scope) ?? `Evidence ${index + 1}`;
    const observed = textValue(entry.observed_display ?? entry.observed);
    const expected = textValue(entry.expected_display ?? entry.expected);
    const outcome = entry.matched === true ? 'Matched' : entry.matched === false ? 'Not matched' : null;
    return [
      `${index + 1}. ${label}`,
      observed ? `Observed: ${observed}` : null,
      expected ? `Expected: ${expected}` : null,
      outcome,
    ].filter(Boolean).join(' · ');
  });
};

const freshnessValue = (finding) => {
  const evaluatedAt = finding?.last_evaluated_at ?? finding?.evaluated_at;
  if (evaluatedAt) return `Evaluated ${formatDiscordTime(evaluatedAt)}`;
  if (typeof finding?.freshness === 'string') return finding.freshness;
  if (finding?.freshness?.label) return finding.freshness.label;
  return null;
};

const freshnessDescription = (finding) => {
  const evaluatedAt = finding?.last_evaluated_at ?? finding?.evaluated_at;
  if (evaluatedAt) return `Last evaluated: ${evaluatedAt}`;
  if (typeof finding?.freshness === 'string') return finding.freshness;
  if (finding?.freshness?.label) return finding.freshness.label;
  return null;
};

const findingDescription = (finding) => [
  finding?.plain_language_summary
    ? `Summary: ${finding.plain_language_summary}`
    : finding?.description
      ? `Description: ${finding.description}`
      : null,
  finding?.remediation_guidance ? `How to correct: ${finding.remediation_guidance}` : null,
  evidenceLines(finding?.evidence).length
    ? `Evidence:\n${evidenceLines(finding.evidence).join('\n')}`
    : null,
  freshnessDescription(finding) ? `Freshness: ${freshnessDescription(finding)}` : null,
].filter(Boolean).join('\n\n');

const presentFinding = (finding) => ({
  ...finding,
  description: findingDescription(finding),
});

const getFindings = async (interaction, context) => normalizeCollection(
  await context.apiService.getMyAuditFindings(actorFromInteraction(interaction)),
);

const findActorFinding = (findings, id) => findings.items.find(
  (finding) => String(findingId(finding)) === String(id),
);

const findingReference = (finding) => {
  const id = findingId(finding);
  return `${findingName(finding)}${id !== undefined && id !== null ? ` (#${id})` : ''}`;
};

const confirmationMessage = (action, finding, state, confirmId, cancelId) => {
  const isSnooze = action === 'snooze';
  return statusMessage({
    title: isSnooze ? 'Confirm Audit Snooze' : 'Confirm Audit Acknowledgement',
    tone: 'warning',
    description: `You are about to ${isSnooze ? 'snooze reminders for' : 'acknowledge'} ${escapeMarkdown(findingReference(finding))}. Nexus will revalidate the finding when you confirm.`,
    fields: [
      { name: 'Finding', value: escapeMarkdown(findingReference(finding)) },
      isSnooze ? { name: 'Duration', value: `${state.hours} hours`, inline: true } : null,
      state.note ? { name: 'Note', value: escapeMarkdown(truncate(state.note, 500)) } : null,
    ],
    footer: isSnooze
      ? 'The finding remains active while reminders are snoozed.'
      : 'The acknowledgement is recorded in Nexus.',
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(confirmId)
        .setLabel(isSnooze ? 'Snooze reminders' : 'Acknowledge finding')
        .setStyle(isSnooze ? ButtonStyle.Primary : ButtonStyle.Success),
      new ButtonBuilder().setCustomId(cancelId).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    )],
  });
};

const findingDetailMessage = (finding, baseUrl) => statusMessage({
  title: `${statusLabel(finding.priority) ?? 'i Info'} · ${escapeMarkdown(findingReference(finding))}`,
  tone: statusTone(finding.priority, 'warning'),
  description: finding?.plain_language_summary
    ? escapeMarkdown(finding.plain_language_summary)
    : finding?.description
      ? escapeMarkdown(finding.description)
      : 'Nexus did not provide a summary for this finding.',
  fields: [
    finding?.remediation_guidance
      ? { name: 'How to correct', value: escapeMarkdown(finding.remediation_guidance) }
      : null,
    evidenceLines(finding?.evidence).length
      ? { name: 'Evidence', value: escapeMarkdown(evidenceLines(finding.evidence).join('\n')) }
      : null,
    finding?.target ? { name: 'Target', value: escapeMarkdown(finding.target), inline: true } : null,
    finding?.target_type ? { name: 'Scope', value: escapeMarkdown(finding.target_type), inline: true } : null,
    finding?.due_at ? { name: 'Due', value: formatDiscordTime(finding.due_at), inline: true } : null,
    finding?.snoozed_until
      ? { name: 'Snoozed until', value: formatDiscordTime(finding.snoozed_until), inline: true }
      : null,
    freshnessValue(finding) ? { name: 'Freshness', value: freshnessValue(finding), inline: true } : null,
    finding?.first_detected_at
      ? { name: 'First detected', value: formatDiscordTime(finding.first_detected_at), inline: true }
      : null,
  ],
  url: resolveDeepLink(baseUrl, finding?.deep_link_path ?? finding?.url ?? '/audit'),
  timestamp: true,
});

const confirmFinding = async (interaction, context, action) => {
  const findings = await getFindings(interaction, context);
  const id = interaction.options.getInteger('finding', true);
  const finding = findActorFinding(findings, id);
  if (!finding) throw Object.assign(new Error('That audit finding is no longer available to you.'), { code: 'NOT_FOUND' });

  const state = {
    finding: findingId(finding),
    name: findingName(finding),
    note: action === 'acknowledge' ? interaction.options.getString('note') ?? undefined : undefined,
    hours: action === 'snooze' ? interaction.options.getInteger('hours', true) : undefined,
  };
  const confirmId = context.sessions.create({
    commandName: 'audit', userId: interaction.user.id, event: `${action}-confirm`, state, oneShot: true,
  });
  const cancelId = context.sessions.create({
    commandName: 'audit', userId: interaction.user.id, event: 'cancel', state: {}, oneShot: true,
  });
  await interaction.editReply(confirmationMessage(action, finding, state, confirmId, cancelId));
};

export const autocomplete = async (interaction, { apiService }) => {
  try {
    const query = `${interaction.options.getFocused?.() ?? ''}`.trim().toLowerCase();
    const findings = normalizeCollection(
      await apiService.getMyAuditFindings(actorFromInteraction(interaction)),
    ).items;
    await interaction.respond(findings
      .filter((finding) => findingId(finding) !== undefined && findingId(finding) !== null)
      .filter((finding) => {
        if (!query) return true;
        return [
          findingId(finding), findingName(finding), finding.plain_language_summary,
          finding.description, finding.target,
        ].filter((value) => value !== undefined && value !== null)
          .join(' ').toLowerCase().includes(query);
      })
      .slice(0, 25)
      .map((finding) => ({
        name: `${findingName(finding)} · #${findingId(finding)}`.slice(0, 100),
        value: `${findingId(finding)}`.slice(0, 100),
      })));
  } catch {
    await interaction.respond([]).catch(() => {});
  }
};

export const execute = async (interaction, context) => {
  await deferEphemeral(interaction);
  const subcommand = interaction.options.getSubcommand();

  try {
    if (subcommand === 'acknowledge' || subcommand === 'snooze') {
      await confirmFinding(interaction, context, subcommand);
      return;
    }

    const findings = await getFindings(interaction, context);
    if (subcommand === 'explain') {
      const finding = findActorFinding(findings, interaction.options.getString('finding', true));
      if (!finding) throw Object.assign(new Error('That audit finding is no longer available to you.'), { code: 'NOT_FOUND' });
      await interaction.editReply(findingDetailMessage(finding, context.apiService.baseUrl));
      return;
    }

    await interaction.editReply(collectionMessage({
      title: 'Your Audit Findings',
      collection: { ...findings, items: findings.items.map(presentFinding) },
      empty: 'No active audit findings.',
      commandName: 'audit',
      userId: interaction.user.id,
      sessions: context.sessions,
      variant: 'audit',
      description: [
        'Active findings, deadlines, and reminder status for your linked nation.',
        markdownLink('Open the audit center in Nexus', resolveDeepLink(context.apiService.baseUrl, '/audit')),
      ].filter(Boolean).join('\n'),
      baseUrl: context.apiService.baseUrl,
      pageSize: 3,
    }));
  } catch (error) {
    await replyError(interaction, error);
  }
};

export const button = async (interaction, context) => {
  if (context.session.event === 'cancel') {
    await interaction.update(statusMessage({
      title: 'Audit Action Cancelled',
      tone: 'neutral',
      description: 'No audit finding was changed.',
    }));
    return;
  }

  await interaction.deferUpdate();
  try {
    const { finding, note, hours } = context.session.state;
    const actor = actorFromInteraction(interaction);
    const result = context.session.event === 'acknowledge-confirm'
      ? await context.apiService.acknowledgeAuditFinding(actor, finding, { note })
      : await context.apiService.snoozeAuditFinding(actor, finding, { hours });
    const acknowledged = context.session.event === 'acknowledge-confirm';
    await interaction.editReply(statusMessage({
      title: acknowledged ? 'Audit Finding Acknowledged' : 'Audit Reminders Snoozed',
      tone: 'success',
      description: escapeMarkdown(truncate(
        result?.message ?? (acknowledged ? 'Audit finding acknowledged.' : 'Audit reminders snoozed.'),
        1000,
      )),
      footer: acknowledged
        ? 'Acknowledgement saved in Nexus.'
        : 'The finding remains active until it is resolved.',
    }));
  } catch (error) { await replyError(interaction, error); }
};
