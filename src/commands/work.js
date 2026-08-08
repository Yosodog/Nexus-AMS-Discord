import { SlashCommandBuilder } from 'discord.js';
import {
  actorFromInteraction, deferEphemeral, replyError,
} from '../utils/commandSupport.js';
import {
  buildEmbed, escapeMarkdown, formatDiscordTime, markdownLink, resolveDeepLink,
  statusLabel, titleCase, truncate,
} from '../utils/discordUi.js';

export const data = new SlashCommandBuilder()
  .setName('work')
  .setDescription('Review your permission-filtered Nexus Operations queue.')
  .addSubcommand((subcommand) => subcommand
    .setName('queue')
    .setDescription('View work items that Nexus allows you to see.')
    .addStringOption((option) => option.setName('type').setDescription('Operations source').setAutocomplete(true))
    .addStringOption((option) => option.setName('priority').setDescription('Priority').addChoices(
      { name: 'P0 — immediate', value: 'p0' },
      { name: 'P1 — urgent', value: 'p1' },
      { name: 'P2 — important', value: 'p2' },
      { name: 'P3 — routine', value: 'p3' },
    ))
    .addStringOption((option) => option.setName('urgency').setDescription('Urgency').addChoices(
      { name: 'Urgent', value: 'urgent' },
      { name: 'Needs attention', value: 'attention' },
      { name: 'Routine', value: 'routine' },
    ))
    .addStringOption((option) => option.setName('freshness').setDescription('Projection freshness').addChoices(
      { name: 'Fresh', value: 'fresh' },
      { name: 'Aging', value: 'aging' },
      { name: 'Stale', value: 'stale' },
      { name: 'Unknown', value: 'unknown' },
    ))
    .addBooleanOption((option) => option.setName('blocked').setDescription('Show only blocked or unblocked work'))
    .addIntegerOption((option) => option.setName('page').setDescription('Results page').setMinValue(1)))
  .addSubcommand((subcommand) => subcommand
    .setName('show')
    .setDescription('Show one current Operations work item.')
    .addStringOption((option) => option.setName('item').setDescription('Work item').setRequired(true).setAutocomplete(true)))
  .setDMPermission(false);

export const help = Object.freeze({
  audience: 'Nexus staff',
  topic: Object.freeze(['staff']),
  examples: Object.freeze(['/work queue', '/work queue priority:p1 blocked:Yes', '/work show item:<work item>']),
  related: Object.freeze(['requests', 'applications', 'audit']),
  capability: 'operations.work-items',
});

const actorLabel = (actor) => {
  if (!actor?.label) return null;
  return escapeMarkdown(truncate(actor.label, 100));
};

const workLink = (item, baseUrl) => {
  const path = item?.next_action?.deep_link_path;
  const url = resolveDeepLink(baseUrl, path);
  return url ? markdownLink(item?.next_action?.label ?? 'Open in Nexus', url) : null;
};

const attentionLine = (item) => [
  item?.attention?.priority ? item.attention.priority.toUpperCase() : null,
  item?.attention?.severity ? titleCase(item.attention.severity) : null,
  item?.attention?.urgency ? titleCase(item.attention.urgency) : null,
  item?.attention?.overdue ? 'Overdue' : null,
].filter(Boolean).join(' · ');

const workField = (item, baseUrl) => {
  const requester = actorLabel(item?.actors?.requester);
  const owner = actorLabel(item?.actors?.owner);
  const lines = [
    [item?.source?.label ? escapeMarkdown(item.source.label) : null, statusLabel(item?.status?.label ?? item?.status?.code)]
      .filter(Boolean).join(' · '),
    attentionLine(item),
    requester ? `**Requester:** ${requester}` : null,
    owner ? `**Owner:** ${owner}` : null,
    item?.actors?.next_actor ? `**Next actor:** ${escapeMarkdown(titleCase(item.actors.next_actor))}` : null,
    item?.attention?.blocked
      ? `**Blocked:** ${escapeMarkdown(item.attention.blocker_summary ?? 'Nexus reports a blocker.')}`
      : null,
    item?.times?.due_at ? `**Due:** ${formatDiscordTime(item.times.due_at)}` : null,
    item?.freshness?.state
      ? `**Freshness:** ${escapeMarkdown(titleCase(item.freshness.state))}${item.freshness.projected_at ? ` · ${formatDiscordTime(item.freshness.projected_at)}` : ''}`
      : null,
    workLink(item, baseUrl),
  ].filter(Boolean);
  return {
    name: truncate(`${item?.attention?.priority?.toUpperCase?.() ?? 'WORK'} · ${item?.title ?? item?.work_key ?? 'Work item'}`, 256),
    value: lines.join('\n') || 'No safe operational details were provided.',
  };
};

const queueMessage = (result, baseUrl) => {
  const items = Array.isArray(result?.data) ? result.data : [];
  const meta = result?.meta ?? {};
  const pagination = meta.pagination ?? {};
  const unavailable = Array.isArray(meta.unavailable_sources) ? meta.unavailable_sources : [];
  const description = unavailable.length
    ? `Nexus returned available work, but ${unavailable.map(({ label, type }) => escapeMarkdown(label ?? type)).join(', ')} could not be refreshed. Counts may be incomplete.`
    : 'Nexus-authorized work across the Operations sources you can access.';

  return {
    embeds: [buildEmbed({
      title: 'Nexus Staff Work Queue',
      tone: unavailable.length ? 'warning' : 'info',
      description: items.length ? description : `${description}\n\nNo work items match these filters.`,
      fields: items.slice(0, 10).map((item) => workField(item, baseUrl)),
      footer: [
        Number.isFinite(Number(pagination.total)) ? `${pagination.total} authorized item${Number(pagination.total) === 1 ? '' : 's'}` : null,
        pagination.last_page ? `Page ${pagination.current_page ?? 1}/${pagination.last_page}` : null,
        meta.complete === false ? 'Partial source data' : null,
      ].filter(Boolean).join(' · ') || null,
      timestamp: true,
    })],
    components: [],
  };
};

const detailMessage = (item, baseUrl) => {
  const facts = item?.facts && typeof item.facts === 'object'
    ? Object.entries(item.facts).slice(0, 8).map(([key, value]) => (
      `**${escapeMarkdown(titleCase(key))}:** ${escapeMarkdown(typeof value === 'object' ? JSON.stringify(value) : value)}`
    ))
    : [];
  const context = Array.isArray(item?.context)
    ? item.context.slice(0, 8).map((entry) => actorLabel(entry)).filter(Boolean)
    : [];
  const baseField = workField(item, baseUrl);
  return {
    embeds: [buildEmbed({
      title: truncate(item?.title ?? item?.work_key ?? 'Nexus Work Item', 256),
      tone: item?.attention?.blocked || item?.attention?.overdue ? 'warning' : 'info',
      description: item?.summary
        ? escapeMarkdown(truncate(item.summary, 2_000))
        : 'Nexus did not provide an additional summary for this item.',
      fields: [
        { name: 'Operational status', value: baseField.value },
        facts.length ? { name: 'Safe facts', value: facts.join('\n') } : null,
        context.length ? { name: 'Related context', value: context.join('\n') } : null,
        item?.times?.entered_queue_at
          ? { name: 'Entered queue', value: formatDiscordTime(item.times.entered_queue_at), inline: true }
          : null,
        item?.times?.source_changed_at
          ? { name: 'Last changed', value: formatDiscordTime(item.times.source_changed_at), inline: true }
          : null,
      ],
      url: resolveDeepLink(baseUrl, item?.next_action?.deep_link_path),
      footer: item?.work_key ? `Work key: ${truncate(item.work_key, 120)}` : null,
      timestamp: true,
    })],
    components: [],
  };
};

const splitWorkKey = (workKey) => {
  const separator = `${workKey ?? ''}`.indexOf(':');
  if (separator <= 0 || separator === `${workKey}`.length - 1) {
    throw Object.assign(new Error('That work-item choice is stale or malformed.'), { code: 'NOT_FOUND' });
  }
  return [`${workKey}`.slice(0, separator), `${workKey}`.slice(separator + 1)];
};

export const execute = async (interaction, context) => {
  await deferEphemeral(interaction);
  const actor = actorFromInteraction(interaction);
  try {
    if (interaction.options.getSubcommand() === 'show') {
      const [type, id] = splitWorkKey(interaction.options.getString('item', true));
      const item = await context.apiService.getStaffWorkItem(actor, type, id);
      await interaction.editReply(detailMessage(item, context.apiService.baseUrl));
      return;
    }

    const result = await context.apiService.getStaffWorkItems(actor, {
      type: interaction.options.getString('type') ?? undefined,
      priority: interaction.options.getString('priority') ?? undefined,
      urgency: interaction.options.getString('urgency') ?? undefined,
      freshness: interaction.options.getString('freshness') ?? undefined,
      blocked: interaction.options.getBoolean('blocked') ?? undefined,
      page: interaction.options.getInteger('page') ?? 1,
      per_page: 10,
    });
    await interaction.editReply(queueMessage(result, context.apiService.baseUrl));
  } catch (error) {
    await replyError(interaction, error);
  }
};

export const autocomplete = async (interaction, { apiService }) => {
  try {
    const actor = actorFromInteraction(interaction);
    const focused = interaction.options.getFocused(true);
    const result = await apiService.getStaffWorkItems(actor, focused.name === 'item'
      ? { q: `${focused.value ?? ''}`.trim(), per_page: 25 }
      : { per_page: 1 });
    if (focused.name === 'type') {
      const query = `${focused.value ?? ''}`.trim().toLowerCase();
      const sources = Object.entries(result?.meta?.authorized_sources ?? {});
      await interaction.respond(sources
        .filter(([type, label]) => `${type} ${label}`.toLowerCase().includes(query))
        .slice(0, 25)
        .map(([value, label]) => ({ name: `${label}`.slice(0, 100), value: value.slice(0, 100) })));
      return;
    }
    const items = Array.isArray(result?.data) ? result.data : [];
    await interaction.respond(items.slice(0, 25).map((item) => ({
      name: `${item?.source?.label ?? item?.source?.type ?? 'Work'} · ${item?.title ?? item?.work_key}`.slice(0, 100),
      value: `${item?.work_key ?? ''}`.slice(0, 100),
    })).filter(({ value }) => value));
  } catch {
    await interaction.respond([]).catch(() => {});
  }
};
