import { SlashCommandBuilder } from 'discord.js';
import {
  accountChoices, actorFromInteraction, collectionMessage, deferEphemeral, executeAutocomplete,
  normalizeCollection, replyError,
} from '../utils/commandSupport.js';
import {
  collectAmounts, handleResourceButton, handleWarAidDecision, resourcePickerPayload, showAmountModal,
} from '../utils/resourceRequestUi.js';

export const data = new SlashCommandBuilder().setName('waraid').setDescription('Request or review war aid.')
  .addSubcommand((sub) => sub.setName('apply').setDescription('Apply for war aid.')
    .addStringOption((option) => option.setName('account').setDescription('Destination account').setRequired(true).setAutocomplete(true))
    .addStringOption((option) => option.setName('note').setDescription('Why the aid is needed').setRequired(true).setMaxLength(255)))
  .addSubcommand((sub) => sub.setName('status').setDescription('View your war aid requests.'))
  .setDMPermission(false);
export const autocomplete = (interaction, { apiService }) => executeAutocomplete(interaction, apiService, accountChoices);
export const execute = async (interaction, context) => {
  if (interaction.options.getSubcommand() === 'apply') {
    await interaction.reply(resourcePickerPayload({
      commandName: 'waraid', interaction, sessions: context.sessions,
      account: interaction.options.getString('account', true), kind: 'war-aid',
      note: interaction.options.getString('note', true),
    }));
    return;
  }
  await deferEphemeral(interaction);
  try {
    const result = await context.apiService.getMyWarAidRequests(actorFromInteraction(interaction));
    await interaction.editReply(collectionMessage({
      title: 'Your War Aid Requests',
      collection: normalizeCollection(result),
      empty: 'No war aid requests found.',
      commandName: 'waraid',
      userId: interaction.user.id,
      sessions: context.sessions,
      variant: 'request',
      description: 'War aid requests submitted by your linked nation.',
      baseUrl: context.apiService.baseUrl,
      pageSize: 4,
    }));
  } catch (error) { await replyError(interaction, error); }
};
export const select = showAmountModal;
export const modal = collectAmounts;
export const button = async (interaction, context) => {
  if (await handleWarAidDecision(interaction, context)) return;
  await handleResourceButton(interaction, context);
};
