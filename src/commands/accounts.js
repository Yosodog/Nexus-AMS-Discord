import { SlashCommandBuilder } from 'discord.js';
import {
  accountChoices, actorFromInteraction, collectionMessage, deferEphemeral,
  executeAutocomplete, normalizeCollection, replyError,
} from '../utils/commandSupport.js';

export const data = new SlashCommandBuilder()
  .setName('accounts')
  .setDescription('View your linked Nexus banking accounts.')
  .addStringOption((option) => option.setName('account').setDescription('Account to view').setAutocomplete(true))
  .setDMPermission(false);

const render = async (interaction, context, state = {}) => {
  const account = state.account ?? interaction.options?.getString?.('account') ?? undefined;
  const page = state.page ?? 1;
  const result = await context.apiService.getMyAccounts(actorFromInteraction(interaction), { account, page });
  const message = collectionMessage({
    title: 'Your Nexus Accounts', collection: normalizeCollection(result),
    empty: 'No linked accounts were found.', commandName: 'accounts', userId: interaction.user.id,
    sessions: context.sessions, state: { account },
  });
  return interaction.editReply(message);
};

export const execute = async (interaction, context) => {
  await deferEphemeral(interaction);
  try { await render(interaction, context); } catch (error) { await replyError(interaction, error); }
};
export const autocomplete = (interaction, { apiService }) => executeAutocomplete(interaction, apiService, accountChoices);
export const button = async (interaction, context) => {
  await interaction.deferUpdate();
  try { await render(interaction, context, context.session.state); } catch (error) { await replyError(interaction, error); }
};
