import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import {
  accountChoices, actorFromInteraction, deferEphemeral, executeAutocomplete, replyError,
} from '../utils/commandSupport.js';

export const data = new SlashCommandBuilder().setName('deposit').setDescription('Create a Nexus deposit request.')
  .addStringOption((option) => option.setName('account').setDescription('Destination account').setRequired(true).setAutocomplete(true))
  .setDMPermission(false);
export const execute = async (interaction, { apiService }) => {
  await deferEphemeral(interaction);
  try {
    const result = await apiService.createDepositRequest(
      actorFromInteraction(interaction), interaction.options.getString('account', true), {},
    );
    const deposit = result?.deposit_request;
    if (!deposit?.deposit_code) throw new TypeError('Nexus did not return a deposit code.');
    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setTitle(result?.reused ? 'Existing Deposit Code' : 'Deposit Code Created')
        .setColor(0x57f287)
        .setDescription(`Use deposit code \`${deposit.deposit_code}\` in your in-game bank transfer note.`)
        .setFooter({ text: `Expires ${deposit.expires_at ?? 'one hour after creation'}. Keep this code private.` })],
    });
  } catch (error) { await replyError(interaction, error); }
};
export const autocomplete = (interaction, { apiService }) => executeAutocomplete(interaction, apiService, accountChoices);
