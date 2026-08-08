import { SlashCommandBuilder } from 'discord.js';
import {
  actorFromInteraction, collectionMessage, deferEphemeral, executeAutocomplete,
  normalizeCollection, replyError, summarizeItem,
} from '../utils/commandSupport.js';
import { buildPlainMessages, escapeMarkdown, truncate } from '../utils/discordUi.js';

export const data = new SlashCommandBuilder().setName('war').setDescription('View active wars and war guidance.')
  .addSubcommand((sub) => sub.setName('active').setDescription('View your active wars.'))
  .addSubcommand((sub) => sub.setName('counter').setDescription('Get counter guidance for a nation.')
    .addIntegerOption((option) => option.setName('nation').setDescription('Nation ID').setRequired(true).setMinValue(1)))
  .addSubcommand((sub) => sub.setName('simulate').setDescription('View a war simulation summary.')
    .addStringOption((option) => option.setName('war').setDescription('War').setRequired(true).setAutocomplete(true)))
  .setDMPermission(false);

export const help = Object.freeze({
  audience: 'Members and military staff',
  topic: Object.freeze(['member', 'military']),
  examples: Object.freeze(['/war active', '/war counter nation:<nation-id>', '/war simulate war:<war>']),
  related: Object.freeze(['raid', 'spy', 'waraid']),
});

const warSearchValues = (war) => [
  war?.label,
  war?.name,
  war?.summary,
  war?.token,
  war?.id,
].filter((value) => value !== undefined && value !== null).map((value) => `${value}`.toLowerCase());

const warChoices = async (interaction, apiService) => {
  const query = `${interaction.options.getFocused()?.trim?.() ?? ''}`.toLowerCase();
  const result = await apiService.getMyActiveWars(actorFromInteraction(interaction));
  return normalizeCollection(result).items
    .filter((war) => !query || warSearchValues(war).some((value) => value.includes(query)))
    .slice(0, 25)
    .map((war) => ({
    name: `${war.label ?? war.name ?? war.summary ?? 'Active war'}`.slice(0, 100),
    value: `${war.token ?? war.id}`.slice(0, 100),
    }))
    .filter((choice) => choice.value && choice.value !== 'undefined');
};
export const autocomplete = (interaction, { apiService }) => executeAutocomplete(interaction, apiService, warChoices);

export const execute = async (interaction, context) => {
  await deferEphemeral(interaction);
  const actor = actorFromInteraction(interaction);
  const subcommand = interaction.options.getSubcommand();
  try {
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
