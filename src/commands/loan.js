import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder,
  SlashCommandBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import {
  accountChoices, actorFromInteraction, collectionMessage, deferEphemeral, executeAutocomplete,
  normalizeCollection, replyError,
} from '../utils/commandSupport.js';

export const data = new SlashCommandBuilder().setName('loan').setDescription('Apply for and manage Nexus loans.')
  .addSubcommand((sub) => sub.setName('apply').setDescription('Apply for a loan.')
    .addStringOption((option) => option.setName('account').setDescription('Destination account').setRequired(true).setAutocomplete(true)))
  .addSubcommand((sub) => sub.setName('status').setDescription('View a loan.')
    .addStringOption((option) => option.setName('loan').setDescription('Loan').setAutocomplete(true)))
  .addSubcommand((sub) => sub.setName('pay').setDescription('Make a loan payment.')
    .addStringOption((option) => option.setName('loan').setDescription('Loan').setRequired(true).setAutocomplete(true))
    .addStringOption((option) => option.setName('account').setDescription('Source account').setRequired(true).setAutocomplete(true)))
  .setDMPermission(false);

const loanChoices = async (interaction, apiService) => {
  const data = await apiService.getMyLoans(actorFromInteraction(interaction), {
    query: interaction.options.getFocused()?.trim?.() ?? '', limit: 25,
  });
  return normalizeCollection(data).items.slice(0, 25).map((loan) => ({
    name: `${loan.label ?? loan.name ?? `Loan ${loan.reference ?? ''}`}`.slice(0, 100),
    value: `${loan.token ?? loan.id}`.slice(0, 100),
  }));
};
export const autocomplete = (interaction, { apiService }) => executeAutocomplete(
  interaction, apiService, interaction.options.getFocused(true).name === 'loan' ? loanChoices : accountChoices,
);

const modalId = (sessions, interaction, event, state, fields) => sessions.create({
  commandName: 'loan', userId: interaction.user.id, event, state: { ...state, fields }, oneShot: true,
});
const fieldId = (sessions, interaction) => sessions.create({
  commandName: 'loan', userId: interaction.user.id, event: 'field', oneShot: true,
});

export const execute = async (interaction, context) => {
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'status') {
    await deferEphemeral(interaction);
    try {
      const result = await context.apiService.getMyLoans(actorFromInteraction(interaction), {
        loan: interaction.options.getString('loan') ?? undefined,
      });
      await interaction.editReply(collectionMessage({
        title: 'Your Loans', collection: normalizeCollection(result), empty: 'No loans found.',
        commandName: 'loan', userId: interaction.user.id,
      }));
    } catch (error) { await replyError(interaction, error); }
    return;
  }

  const amountId = fieldId(context.sessions, interaction);
  const fields = { amountId };
  const state = { account: interaction.options.getString('account', true) };
  const modal = new ModalBuilder().setTitle(subcommand === 'apply' ? 'Loan application' : 'Loan payment');
  if (subcommand === 'pay') state.loan = interaction.options.getString('loan', true);
  const rows = [new ActionRowBuilder().addComponents(new TextInputBuilder()
    .setCustomId(amountId).setLabel('Amount').setPlaceholder('Positive decimal')
    .setStyle(TextInputStyle.Short).setRequired(true))];
  if (subcommand === 'apply') {
    const termId = fieldId(context.sessions, interaction);
    fields.termId = termId;
    rows.push(new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId(termId).setLabel('Term (weeks)').setPlaceholder('1 to 52 weeks')
      .setStyle(TextInputStyle.Short).setRequired(true)));
  }
  modal.setCustomId(modalId(context.sessions, interaction, subcommand, state, fields)).addComponents(...rows);
  await interaction.showModal(modal);
};

export const modal = async (interaction, context) => {
  const { event, state } = context.session;
  const amount = interaction.fields.getTextInputValue(state.fields.amountId).trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(amount) || !/[1-9]/.test(amount)) {
    await interaction.reply({ content: 'Amount must be a positive decimal with no more than 2 decimal places.', ephemeral: true });
    return;
  }
  if (event === 'apply') {
    const term = interaction.fields.getTextInputValue(state.fields.termId).trim();
    if (!/^(?:[1-9]|[1-4]\d|5[0-2])$/.test(term)) {
      await interaction.reply({ content: 'Term must be between 1 and 52 weeks.', ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    try {
      const preview = await context.apiService.previewLoanApplication(actorFromInteraction(interaction), {
        account_id: Number(state.account), amount, term_weeks: Number(term),
      });
      const previewToken = `${preview?.intent?.id ?? ''}`;
      if (!previewToken) throw new TypeError('Loan preview is missing an opaque token.');
      const confirmId = context.sessions.create({
        commandName: 'loan', userId: interaction.user.id, event: 'confirm-application',
        state: { previewToken }, oneShot: true,
      });
      await interaction.editReply({
        embeds: [new EmbedBuilder().setTitle('Review Loan Application').setColor(0xfee75c)
          .setDescription(preview.summary ?? 'Nexus validated the application. Confirm to submit it.')],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(confirmId).setLabel('Confirm application').setStyle(ButtonStyle.Success),
        )],
      });
    } catch (error) { await replyError(interaction, error); }
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    const preview = await context.apiService.previewLoanPayment(actorFromInteraction(interaction), {
      loan_id: Number(state.loan), account_id: Number(state.account), amount,
    });
    const previewToken = `${preview?.intent?.id ?? ''}`;
    if (!previewToken) throw new TypeError('Loan payment preview is missing an opaque token.');
    const confirmId = context.sessions.create({
      commandName: 'loan', userId: interaction.user.id, event: 'confirm-payment',
      state: { previewToken }, oneShot: true,
    });
    await interaction.editReply({
      embeds: [new EmbedBuilder().setTitle('Review Loan Payment').setColor(0xfee75c)
        .setDescription(preview.summary ?? 'Nexus validated the payment. Confirm to submit it.')],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(confirmId).setLabel('Confirm payment').setStyle(ButtonStyle.Success),
      )],
    });
  } catch (error) { await replyError(interaction, error); }
};

export const button = async (interaction, context) => {
  await interaction.deferUpdate();
  try {
    if (context.session.event === 'confirm-application') {
      const result = await context.apiService.confirmLoanApplication(actorFromInteraction(interaction), {
        intent_id: context.session.state.previewToken,
      });
      await interaction.editReply({ content: result?.message ?? 'Loan application submitted.', embeds: [], components: [] });
      return;
    }
    if (context.session.event !== 'confirm-payment') return;
    const result = await context.apiService.confirmLoanPayment(actorFromInteraction(interaction), {
      intent_id: context.session.state.previewToken,
    });
    await interaction.editReply({ content: result?.message ?? 'Loan payment submitted.', embeds: [], components: [] });
  } catch (error) { await replyError(interaction, error); }
};
