import { SlashCommandBuilder } from 'discord.js';
import {
  accountChoices, actorFromInteraction, collectionMessage, deferEphemeral,
  executeAutocomplete, normalizeCollection, replyError,
} from '../utils/commandSupport.js';
import { titleCase, truncate } from '../utils/discordUi.js';

const TYPES = ['all', 'deposit', 'withdrawal', 'internal', 'member-transfer'];
const STATUSES = ['all', 'pending', 'completed', 'failed', 'needs-attention'];

export const data = new SlashCommandBuilder()
  .setName('transactions')
  .setDescription('View Nexus banking transactions.')
  .addStringOption((option) => option.setName('account').setDescription('Account').setRequired(true).setAutocomplete(true))
  .addStringOption((option) => {
    option.setName('type').setDescription('Transaction type');
    TYPES.forEach((value) => option.addChoices({ name: value, value }));
    return option;
  })
  .addStringOption((option) => {
    option.setName('status').setDescription('Transaction status');
    STATUSES.forEach((value) => option.addChoices({ name: value, value }));
    return option;
  })
  .setDMPermission(false);

export const help = Object.freeze({
  audience: 'Members',
  topic: Object.freeze(['member', 'finance']),
  examples: Object.freeze(['/transactions account:<account> type:<type> status:<status>']),
  related: Object.freeze(['accounts', 'deposit', 'withdraw']),
});

const render = async (interaction, context, state = {}) => {
  const filters = {
    account: state.account ?? interaction.options?.getString?.('account'),
    type: state.type ?? interaction.options?.getString?.('type') ?? 'all',
    status: state.status ?? interaction.options?.getString?.('status') ?? 'all',
    page: state.page ?? 1,
  };
  const result = await context.apiService.getMyTransactions(actorFromInteraction(interaction), filters);
  return interaction.editReply(collectionMessage({
    title: 'Transactions', collection: normalizeCollection(result), empty: 'No matching transactions.',
    commandName: 'transactions', userId: interaction.user.id, sessions: context.sessions, state: filters,
    variant: 'transaction', baseUrl: context.apiService.baseUrl,
    description: `Account #${truncate(filters.account, 64)} · Type: ${titleCase(filters.type)} · Status: ${titleCase(filters.status)}`,
  }));
};
export const execute = async (interaction, context) => {
  await deferEphemeral(interaction);
  try { await render(interaction, context); } catch (error) { await replyError(interaction, error); }
};
export const autocomplete = (interaction, { apiService }) => executeAutocomplete(interaction, apiService);
export const button = async (interaction, context) => {
  await interaction.deferUpdate();
  try { await render(interaction, context, context.session.state); } catch (error) { await replyError(interaction, error); }
};
