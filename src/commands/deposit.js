import { ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder } from 'discord.js';
import {
  accountChoices, actorFromInteraction, deferEphemeral, executeAutocomplete, normalizeCollection, replyError,
} from '../utils/commandSupport.js';
import {
  formatDiscordTime, statusLabel, statusMessage, truncate,
} from '../utils/discordUi.js';

export const data = new SlashCommandBuilder().setName('deposit').setDescription('Create a Nexus deposit request.')
  .addStringOption((option) => option.setName('account').setDescription('Destination account').setRequired(true).setAutocomplete(true))
  .setDMPermission(false);

export const help = Object.freeze({
  audience: 'Members',
  topic: Object.freeze(['member', 'finance']),
  examples: Object.freeze(['/deposit account:<account>']),
  related: Object.freeze(['accounts', 'withdraw', 'transactions']),
});

const selectedAccount = async (interaction, apiService, accountId) => {
  const result = await apiService.getMyAccounts(actorFromInteraction(interaction), {
    account: accountId,
    limit: 1,
  });
  const account = normalizeCollection(result).items.find((item) => `${item?.id}` === `${accountId}`);
  if (!account) {
    throw Object.assign(new Error('The selected account is not available to your Nexus account.'), {
      code: 'NOT_FOUND',
    });
  }
  return account;
};

const depositResultMessage = (result, accountId) => {
  const deposit = result?.deposit_request;
  if (!deposit?.deposit_code) throw new TypeError('Nexus did not return a deposit code.');
  return statusMessage({
    title: result?.reused ? 'Existing Deposit Code' : 'Deposit Code Created',
    tone: 'success',
    description: `Use deposit code \`${truncate(deposit.deposit_code, 100)}\` in your in-game bank transfer note.`,
    fields: [
      { name: 'Destination account', value: `Account #${deposit.account_id ?? accountId}`, inline: true },
      deposit.status ? { name: 'Status', value: statusLabel(deposit.status), inline: true } : null,
      deposit.expires_at
        ? { name: 'Expires', value: formatDiscordTime(deposit.expires_at, 'F'), inline: true }
        : { name: 'Expires', value: 'About one hour after creation', inline: true },
    ],
    footer: 'Keep this code private. A reused code still points to the existing pending deposit request.',
    timestamp: true,
  });
};

export const execute = async (interaction, context) => {
  await deferEphemeral(interaction);
  try {
    const requestedAccount = interaction.options.getString('account', true);
    const account = await selectedAccount(interaction, context.apiService, requestedAccount);
    const accountId = `${account.id ?? requestedAccount}`;
    const accountName = `${account.name ?? account.label ?? 'Selected account'}`.slice(0, 100);
    const confirmId = context.sessions.create({
      commandName: 'deposit',
      userId: interaction.user.id,
      event: 'confirm',
      state: { accountId, accountName },
      oneShot: true,
    });
    await interaction.editReply(statusMessage({
      title: 'Review Deposit Request',
      tone: 'warning',
      description: 'Nexus authorized this destination account. Confirm to create a deposit request and receive a deposit code.',
      fields: [
        { name: 'Destination account', value: `${accountName} (#${accountId})`, inline: true },
        account.frozen ? { name: 'Account status', value: 'Frozen', inline: true } : null,
      ],
      footer: 'Nexus will revalidate account access and any finance rules when you confirm.',
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(confirmId).setLabel('Create deposit request').setStyle(ButtonStyle.Success),
      )],
    }));
  } catch (error) { await replyError(interaction, error); }
};
export const autocomplete = (interaction, { apiService }) => executeAutocomplete(interaction, apiService, accountChoices);

export const button = async (interaction, context) => {
  await interaction.deferUpdate();
  try {
    const { accountId } = context.session.state;
    const result = await context.apiService.createDepositRequest(
      actorFromInteraction(interaction), accountId, {},
    );
    await interaction.editReply(depositResultMessage(result, accountId));
  } catch (error) { await replyError(interaction, error); }
};
