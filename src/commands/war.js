import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder,
  SlashCommandBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import {
  actorFromInteraction, collectionMessage, deferEphemeral, executeAutocomplete,
  normalizeCollection, replyError, summarizeItem,
} from '../utils/commandSupport.js';
import {
  buildEmbed, buildPlainMessages, escapeMarkdown, statusMessage, truncate,
} from '../utils/discordUi.js';

export const data = new SlashCommandBuilder().setName('war').setDescription('View wars and war assignments.')
  .addSubcommand((sub) => sub.setName('active').setDescription('View your active wars.'))
  .addSubcommand((sub) => sub.setName('assignments').setDescription('View and respond to war assignments.'))
  .addSubcommand((sub) => sub.setName('counter').setDescription('Get counter guidance for a nation.')
    .addIntegerOption((option) => option.setName('nation').setDescription('Nation ID').setRequired(true).setMinValue(1)))
  .addSubcommand((sub) => sub.setName('simulate').setDescription('View a war simulation summary.')
    .addStringOption((option) => option.setName('war').setDescription('War').setRequired(true).setAutocomplete(true)))
  .setDMPermission(false);

const warChoices = async (interaction, apiService) => {
  const result = await apiService.getMyActiveWars(actorFromInteraction(interaction), {
    query: interaction.options.getFocused()?.trim?.() ?? '', limit: 25,
  });
  return normalizeCollection(result).items.slice(0, 25).map((war) => ({
    name: `${war.label ?? war.name ?? war.summary ?? 'Active war'}`.slice(0, 100),
    value: `${war.token ?? war.id}`.slice(0, 100),
  }));
};
export const autocomplete = (interaction, { apiService }) => executeAutocomplete(interaction, apiService, warChoices);

const ASSIGNMENTS_PAGE_SIZE = 2;

const assignmentsPayload = (interaction, context, result, requestedPage = 1) => {
  const items = normalizeCollection(result).items;
  const pages = Math.max(1, Math.ceil(items.length / ASSIGNMENTS_PAGE_SIZE));
  const page = Math.min(Math.max(1, Number(requestedPage) || 1), pages);
  const start = (page - 1) * ASSIGNMENTS_PAGE_SIZE;
  const pageItems = items.slice(start, start + ASSIGNMENTS_PAGE_SIZE);
  const payload = collectionMessage({
    title: 'War Assignments',
    collection: {
      items: pageItems,
      page,
      pages,
      total: items.length,
      perPage: ASSIGNMENTS_PAGE_SIZE,
      remote: true,
    },
    empty: 'No active war assignments.',
    commandName: 'war',
    userId: interaction.user.id,
    sessions: context.sessions,
    event: 'assignments-page',
    state: { items },
    variant: 'war-assignment',
    description: 'Current plan and counter assignments awaiting your response.',
    baseUrl: context.apiService.baseUrl,
    pageSize: ASSIGNMENTS_PAGE_SIZE,
  });
  for (const assignment of pageItems) {
    const type = assignment.type;
    const id = assignment.id;
    if (!['plan', 'counter'].includes(type) || id === undefined) continue;
    payload.components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(context.sessions.create({ commandName: 'war', userId: interaction.user.id,
        event: 'acknowledge', state: { type, id }, oneShot: true }))
        .setLabel(truncate(`Acknowledge ${assignment.label ?? id}`, 80)).setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(context.sessions.create({ commandName: 'war', userId: interaction.user.id,
        event: 'unavailable', state: { type, id }, oneShot: true }))
        .setLabel('Unavailable').setStyle(ButtonStyle.Danger),
    ));
  }
  return payload;
};

export const execute = async (interaction, context) => {
  await deferEphemeral(interaction);
  const actor = actorFromInteraction(interaction);
  const subcommand = interaction.options.getSubcommand();
  try {
    if (subcommand === 'assignments') {
      const result = await context.apiService.getMyWarAssignments(actor);
      await interaction.editReply(assignmentsPayload(interaction, context, result));
      return;
    }
    if (subcommand === 'counter') {
      const result = await context.apiService.getWarCounterRecommendation(actor, interaction.options.getInteger('nation', true));
      await interaction.editReply(collectionMessage({
        title: 'Counter Guidance',
        collection: normalizeCollection(result),
        empty: 'No counter guidance is available.',
        commandName: 'war',
        userId: interaction.user.id,
        sessions: context.sessions,
        variant: 'war-counter',
        description: `Recommended counters for nation #${interaction.options.getInteger('nation', true)}.`,
        baseUrl: context.apiService.baseUrl,
        pageSize: 3,
      }));
      return;
    }
    if (subcommand === 'simulate') {
      const result = await context.apiService.getWarSimulation(actor, interaction.options.getString('war', true));
      const summary = typeof result?.summary === 'string'
        ? escapeMarkdown(truncate(result.summary, 6_000))
        : summarizeItem(result);
      const messages = buildPlainMessages({
        title: 'War Simulation',
        tone: 'military',
        description: summary,
        footer: 'Simulation results are estimates. Verify the live war state before acting.',
      });
      await interaction.editReply(messages[0]);
      for (const message of messages.slice(1)) {
        await interaction.followUp({ ...message, ephemeral: true });
      }
      return;
    }
    const result = await context.apiService.getMyActiveWars(actor);
    await interaction.editReply(collectionMessage({
      title: 'Active Wars',
      collection: normalizeCollection(result),
      empty: 'No active wars.',
      commandName: 'war',
      userId: interaction.user.id,
      sessions: context.sessions,
      variant: 'war',
      description: 'Wars currently active for your linked nation.',
      baseUrl: context.apiService.baseUrl,
      pageSize: 3,
    }));
  } catch (error) { await replyError(interaction, error); }
};
export const button = async (interaction, context) => {
  const { event, state } = context.session;
  if (event === 'assignments-page') {
    await interaction.deferUpdate();
    try {
      await interaction.editReply(assignmentsPayload(interaction, context, state.items, state.page));
    } catch (error) {
      await replyError(interaction, error, 'Assignments Unavailable');
    }
    return;
  }
  if (event === 'unavailable') {
    const reasonId = context.sessions.create({ commandName: 'war', userId: interaction.user.id, event: 'field', oneShot: true });
    const modalId = context.sessions.create({ commandName: 'war', userId: interaction.user.id,
      event: 'unavailable-reason', state: { ...state, reasonId }, oneShot: true });
    await interaction.showModal(new ModalBuilder().setCustomId(modalId).setTitle('Assignment unavailable')
      .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(reasonId)
        .setLabel('Reason').setMaxLength(255).setRequired(true).setStyle(TextInputStyle.Paragraph))));
    return;
  }
  await interaction.deferUpdate();
  try {
    const result = await context.apiService.respondToWarAssignment(actorFromInteraction(interaction), state.type, state.id, {
      response: 'acknowledged',
    });
    await interaction.editReply(statusMessage({
      title: 'Assignment Acknowledged',
      tone: 'success',
      description: escapeMarkdown(truncate(result?.message ?? 'Assignment acknowledged.', 1000)),
      footer: 'Your assignment response has been saved.',
    }));
  } catch (error) { await replyError(interaction, error); }
};

export const modal = async (interaction, context) => {
  const { type, id, reasonId } = context.session.state;
  const reason = interaction.fields.getTextInputValue(reasonId).trim();
  if (!reason) {
    await interaction.reply({
      ...statusMessage({
        title: 'Reason Required',
        tone: 'danger',
        description: 'Explain why you cannot take this assignment so military staff can reassign it.',
      }),
      ephemeral: true,
    });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  try {
    const result = await context.apiService.respondToWarAssignment(actorFromInteraction(interaction), type, id, {
      response: 'unavailable', reason,
    });
    await interaction.editReply(statusMessage({
      title: 'Assignment Marked Unavailable',
      tone: 'warning',
      description: escapeMarkdown(truncate(result?.message ?? 'Assignment marked unavailable.', 1000)),
      footer: 'Military staff can now reassign this target.',
    }));
  } catch (error) { await replyError(interaction, error); }
};
