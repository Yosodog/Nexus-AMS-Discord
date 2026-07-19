import { SlashCommandBuilder } from 'discord.js';
import {
  accountChoices, actorFromInteraction, deferEphemeral, executeAutocomplete, replyError,
} from '../utils/commandSupport.js';
import {
  formatDiscordTime, statusLabel, statusMessage, truncate,
} from '../utils/discordUi.js';

export const data = new SlashCommandBuilder().setName('deposit').setDescription('Create a Nexus deposit request.')
  .addStringOption((option) => option.setName('account').setDescription('Destination account').setRequired(true).setAutocomplete(true))
  .setDMPermission(false);
export const execute = async (interaction, { apiService }) => {
  await deferEphemeral(interaction);
  try {
    const requestedAccount = interaction.options.getString('account', true);
    const result = await apiService.createDepositRequest(
      actorFromInteraction(interaction), requestedAccount, {},
    );
    const deposit = result?.deposit_request;
    if (!deposit?.deposit_code) throw new TypeError('Nexus did not return a deposit code.');
    await interaction.editReply(statusMessage({
      title: result?.reused ? 'Existing Deposit Code' : 'Deposit Code Created',
      tone: 'success',
      description: `Use deposit code \`${truncate(deposit.deposit_code, 100)}\` in your in-game bank transfer note.`,
      fields: [
        { name: 'Destination account', value: `Account #${deposit.account_id ?? requestedAccount}`, inline: true },
        deposit.status ? { name: 'Status', value: statusLabel(deposit.status), inline: true } : null,
        deposit.expires_at
          ? { name: 'Expires', value: formatDiscordTime(deposit.expires_at, 'F'), inline: true }
          : { name: 'Expires', value: 'About one hour after creation', inline: true },
      ],
      footer: 'Keep this code private. A reused code still points to the existing pending deposit request.',
      timestamp: true,
    }));
  } catch (error) { await replyError(interaction, error); }
};
export const autocomplete = (interaction, { apiService }) => executeAutocomplete(interaction, apiService, accountChoices);
