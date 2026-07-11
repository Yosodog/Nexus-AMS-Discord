import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder,
  SlashCommandBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import {
  actorFromInteraction, collectionMessage, deferEphemeral, executeAutocomplete,
  normalizeCollection, replyError, summarizeItem,
} from '../utils/commandSupport.js';

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

const assignmentsPayload = (interaction, context, result) => {
  const collection = normalizeCollection(result);
  const embeds = [new EmbedBuilder().setTitle('War Assignments').setColor(0x5865f2)
    .setDescription(collection.items.length
      ? collection.items.slice(0, 6).map(summarizeItem).join('\n\n').slice(0, 3900)
      : 'No active war assignments.')];
  const components = [];
  for (const assignment of collection.items.slice(0, 2)) {
    const type = assignment.type;
    const id = assignment.id;
    if (!['plan', 'counter'].includes(type) || id === undefined) continue;
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(context.sessions.create({ commandName: 'war', userId: interaction.user.id,
        event: 'acknowledge', state: { type, id }, oneShot: true }))
        .setLabel(`Acknowledge ${assignment.label ?? id}`.slice(0, 80)).setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(context.sessions.create({ commandName: 'war', userId: interaction.user.id,
        event: 'unavailable', state: { type, id }, oneShot: true }))
        .setLabel('Unavailable').setStyle(ButtonStyle.Danger),
    ));
  }
  return { embeds, components };
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
        title: 'Counter Guidance', collection: normalizeCollection(result), empty: 'No counter guidance is available.',
        commandName: 'war', userId: interaction.user.id,
      }));
      return;
    }
    if (subcommand === 'simulate') {
      const result = await context.apiService.getWarSimulation(actor, interaction.options.getString('war', true));
      await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('War Simulation').setColor(0x5865f2)
        .setDescription(result?.summary ?? summarizeItem(result))] });
      return;
    }
    const result = await context.apiService.getMyActiveWars(actor);
    await interaction.editReply(collectionMessage({
      title: 'Active Wars', collection: normalizeCollection(result), empty: 'No active wars.',
      commandName: 'war', userId: interaction.user.id,
    }));
  } catch (error) { await replyError(interaction, error); }
};
export const button = async (interaction, context) => {
  const { event, state } = context.session;
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
    await interaction.editReply({ content: result?.message ?? 'Assignment acknowledged.', embeds: [], components: [] });
  } catch (error) { await replyError(interaction, error); }
};

export const modal = async (interaction, context) => {
  const { type, id, reasonId } = context.session.state;
  const reason = interaction.fields.getTextInputValue(reasonId).trim();
  if (!reason) {
    await interaction.reply({ content: 'A reason is required.', ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  try {
    const result = await context.apiService.respondToWarAssignment(actorFromInteraction(interaction), type, id, {
      response: 'unavailable', reason,
    });
    await interaction.editReply({ content: result?.message ?? 'Assignment marked unavailable.' });
  } catch (error) { await replyError(interaction, error); }
};
