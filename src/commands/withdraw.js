import { SlashCommandBuilder } from 'discord.js';
import { accountChoices, executeAutocomplete } from '../utils/commandSupport.js';
import {
  collectAmounts, handleResourceButton, handleWithdrawalDecision, resourcePickerPayload, showAmountModal,
} from '../utils/resourceRequestUi.js';

export const data = new SlashCommandBuilder().setName('withdraw').setDescription('Create and confirm a Nexus withdrawal.')
  .addStringOption((option) => option.setName('account').setDescription('Source account').setRequired(true).setAutocomplete(true))
  .setDMPermission(false);

export const help = Object.freeze({
  audience: 'Members',
  topic: Object.freeze(['member', 'finance']),
  examples: Object.freeze(['/withdraw account:<account>']),
  related: Object.freeze(['accounts', 'deposit', 'transactions']),
});

export const execute = (interaction, { sessions }) => interaction.reply(resourcePickerPayload({
  commandName: 'withdraw', interaction, sessions, account: interaction.options.getString('account', true), kind: 'withdrawal',
}));
export const autocomplete = (interaction, { apiService }) => executeAutocomplete(interaction, apiService, accountChoices);
export const select = showAmountModal;
export const modal = collectAmounts;
export const button = async (interaction, context) => {
  if (await handleWithdrawalDecision(interaction, context)) return;
  await handleResourceButton(interaction, context);
};
