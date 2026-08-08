import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder,
  SlashCommandBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import {
  accountChoices, actorFromInteraction, collectionMessage, deferEphemeral, executeAutocomplete,
  normalizeCollection, replyError,
} from '../utils/commandSupport.js';
import {
  buildEmbed, formatDiscordTime, formatMoney, resolveDeepLink, statusLabel, statusMessage, truncate,
} from '../utils/discordUi.js';

export const data = new SlashCommandBuilder().setName('loan').setDescription('Apply for and manage Nexus loans.')
  .addSubcommand((sub) => sub.setName('apply').setDescription('Apply for a loan.')
    .addStringOption((option) => option.setName('account').setDescription('Destination account').setRequired(true).setAutocomplete(true)))
  .addSubcommand((sub) => sub.setName('status').setDescription('View a loan.')
    .addStringOption((option) => option.setName('loan').setDescription('Loan').setAutocomplete(true)))
  .addSubcommand((sub) => sub.setName('pay').setDescription('Make a loan payment.')
    .addStringOption((option) => option.setName('loan').setDescription('Loan').setRequired(true).setAutocomplete(true))
    .addStringOption((option) => option.setName('account').setDescription('Source account').setRequired(true).setAutocomplete(true)))
  .setDMPermission(false);

export const help = Object.freeze({
  audience: 'Members',
  topic: Object.freeze(['member', 'finance']),
  examples: Object.freeze(['/loan apply account:<account>', '/loan status', '/loan pay loan:<loan> account:<account>']),
  related: Object.freeze(['accounts', 'grant', 'deposit']),
});

const loanSearchValues = (loan) => [
  loan?.label,
  loan?.name,
  loan?.reference,
  loan?.token,
  loan?.id,
].filter((value) => value !== undefined && value !== null).map((value) => `${value}`.toLowerCase());

const filterLoans = (loans, query, exact = false) => {
  const normalizedQuery = `${query ?? ''}`.trim().toLowerCase();
  if (!normalizedQuery) return loans;
  return loans.filter((loan) => loanSearchValues(loan).some((value) => (
    exact ? value === normalizedQuery : value.includes(normalizedQuery)
  )));
};

const loanChoices = async (interaction, apiService) => {
  const query = interaction.options.getFocused()?.trim?.() ?? '';
  const data = await apiService.getMyLoans(actorFromInteraction(interaction));
  return filterLoans(normalizeCollection(data).items, query).slice(0, 25).map((loan) => ({
    name: `${loan.label ?? loan.name ?? `Loan ${loan.reference ?? ''}`}`.slice(0, 100),
    value: `${loan.token ?? loan.id}`.slice(0, 100),
  })).filter((choice) => choice.value && choice.value !== 'undefined');
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
      const selectedLoan = interaction.options.getString('loan')?.trim() ?? '';
      const result = await context.apiService.getMyLoans(actorFromInteraction(interaction));
      const collection = normalizeCollection(result);
      const visibleLoans = selectedLoan
        ? normalizeCollection(filterLoans(collection.items, selectedLoan, true))
        : collection;
      await interaction.editReply(collectionMessage({
        title: 'Your Loans', collection: visibleLoans, empty: 'No loans found.',
        commandName: 'loan', userId: interaction.user.id, sessions: context.sessions,
        variant: 'loan', baseUrl: context.apiService.baseUrl,
        description: selectedLoan
          ? 'Showing the selected loan with its current balance and payment schedule.'
          : 'Current loans, balances, and upcoming payment details.',
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
    .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(16))];
  if (subcommand === 'apply') {
    const termId = fieldId(context.sessions, interaction);
    fields.termId = termId;
    rows.push(new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId(termId).setLabel('Term (weeks)').setPlaceholder('1 to 52 weeks')
      .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(2)));
  }
  modal.setCustomId(modalId(context.sessions, interaction, subcommand, state, fields)).addComponents(...rows);
  await interaction.showModal(modal);
};

export const modal = async (interaction, context) => {
  const { event, state } = context.session;
  const amount = interaction.fields.getTextInputValue(state.fields.amountId).trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(amount) || !/[1-9]/.test(amount)) {
    await interaction.reply({
      ...statusMessage({
        title: 'Invalid Amount',
        tone: 'danger',
        description: 'Enter a positive decimal with no more than two decimal places.',
      }),
      ephemeral: true,
    });
    return;
  }
  if (event === 'apply') {
    const term = interaction.fields.getTextInputValue(state.fields.termId).trim();
    if (!/^(?:[1-9]|[1-4]\d|5[0-2])$/.test(term)) {
      await interaction.reply({
        ...statusMessage({
          title: 'Invalid Loan Term',
          tone: 'danger',
          description: 'Enter a whole number between 1 and 52 weeks.',
        }),
        ephemeral: true,
      });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    try {
      const preview = await context.apiService.previewLoanApplication(actorFromInteraction(interaction), {
        account_id: Number(state.account), amount, term_weeks: Number(term),
      });
      const previewToken = `${preview?.intent?.id ?? ''}`;
      if (!previewToken) throw new TypeError('Loan preview is missing an opaque token.');
      const authoritativeAmount = preview?.amount ?? preview?.intent?.amount ?? amount;
      const confirmId = context.sessions.create({
        commandName: 'loan', userId: interaction.user.id, event: 'confirm-application',
        state: {
          previewToken,
          accountId: state.account,
          amount: authoritativeAmount,
          termWeeks: Number(term),
        },
        oneShot: true,
      });
      await interaction.editReply({
        embeds: [buildEmbed({
          title: 'Review Loan Application',
          tone: 'warning',
          description: truncate(
            preview?.summary ?? 'Nexus validated the application. Confirm to submit it.',
            1200,
          ),
          fields: [
            { name: 'Destination account', value: `Account #${state.account}`, inline: true },
            { name: 'Validated amount', value: formatMoney(authoritativeAmount), inline: true },
            { name: 'Term', value: `${term} weeks`, inline: true },
            preview?.intent?.expires_at
              ? { name: 'Preview expires', value: formatDiscordTime(preview.intent.expires_at), inline: true }
              : null,
          ],
          footer: 'Nexus will revalidate eligibility when you confirm.',
        })],
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
    const breakdown = preview?.breakdown ?? {};
    const authoritativeAmount = breakdown.amount ?? preview?.amount ?? amount;
    const confirmId = context.sessions.create({
      commandName: 'loan', userId: interaction.user.id, event: 'confirm-payment',
      state: {
        previewToken,
        loanId: state.loan,
        accountId: state.account,
        amount: authoritativeAmount,
        breakdown,
      },
      oneShot: true,
    });
    await interaction.editReply({
      embeds: [buildEmbed({
        title: 'Review Loan Payment',
        tone: 'warning',
        description: truncate(
          preview?.summary ?? 'Nexus validated the payment amount and allocation. Confirm to submit it.',
          1200,
        ),
        fields: [
          { name: 'Loan', value: `#${state.loan}`, inline: true },
          { name: 'Source account', value: `Account #${state.account}`, inline: true },
          { name: 'Payment applied', value: formatMoney(authoritativeAmount), inline: true },
          breakdown.principal !== undefined
            ? { name: 'To principal', value: formatMoney(breakdown.principal), inline: true }
            : null,
          breakdown.interest !== undefined
            ? { name: 'To interest', value: formatMoney(breakdown.interest), inline: true }
            : null,
          breakdown.remaining_after !== undefined
            ? { name: 'Balance after payment', value: formatMoney(breakdown.remaining_after), inline: true }
            : null,
          preview?.intent?.expires_at
            ? { name: 'Preview expires', value: formatDiscordTime(preview.intent.expires_at), inline: true }
            : null,
        ],
        footer: 'The applied amount is authoritative and may be lower than requested when it pays the loan in full.',
      })],
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
      const loan = result?.loan ?? result ?? {};
      const accountId = loan?.account_id ?? context.session.state.accountId;
      const amount = loan?.amount ?? context.session.state.amount;
      const termWeeks = loan?.term_weeks ?? context.session.state.termWeeks;
      await interaction.editReply(statusMessage({
        title: 'Loan Application Submitted',
        tone: 'success',
        description: truncate(result?.message ?? 'Nexus accepted the loan application for processing.', 1200),
        fields: [
          loan?.id !== undefined ? { name: 'Loan', value: `#${loan.id}`, inline: true } : null,
          accountId !== undefined
            ? { name: 'Destination account', value: `Account #${accountId}`, inline: true }
            : null,
          amount !== undefined ? { name: 'Amount', value: formatMoney(amount), inline: true } : null,
          termWeeks !== undefined ? { name: 'Term', value: `${termWeeks} weeks`, inline: true } : null,
          loan?.status ? { name: 'Status', value: statusLabel(loan.status), inline: true } : null,
          loan?.created_at ? { name: 'Submitted', value: formatDiscordTime(loan.created_at), inline: true } : null,
        ],
        url: resolveDeepLink(context.apiService.baseUrl, loan?.deep_link_path ?? loan?.url),
        timestamp: true,
      }));
      return;
    }
    if (context.session.event !== 'confirm-payment') return;
    const result = await context.apiService.confirmLoanPayment(actorFromInteraction(interaction), {
      intent_id: context.session.state.previewToken,
    });
    const loan = result?.loan ?? result ?? {};
    const loanId = loan?.id ?? context.session.state.loanId;
    const accountId = context.session.state.accountId;
    const appliedAmount = context.session.state.amount;
    await interaction.editReply(statusMessage({
      title: 'Loan Payment Submitted',
      tone: 'success',
      description: truncate(result?.message ?? 'Nexus applied the payment to the loan.', 1200),
      fields: [
        loanId !== undefined ? { name: 'Loan', value: `#${loanId}`, inline: true } : null,
        accountId !== undefined ? { name: 'Source account', value: `Account #${accountId}`, inline: true } : null,
        appliedAmount !== undefined
          ? { name: 'Payment applied', value: formatMoney(appliedAmount), inline: true }
          : null,
        loan?.remaining_balance !== undefined
          ? { name: 'Remaining balance', value: formatMoney(loan.remaining_balance), inline: true }
          : null,
        loan?.status ? { name: 'Status', value: statusLabel(loan.status), inline: true } : null,
        loan?.next_due_date
          ? { name: 'Next due', value: formatDiscordTime(loan.next_due_date, 'D'), inline: true }
          : null,
      ],
      url: resolveDeepLink(context.apiService.baseUrl, loan?.deep_link_path ?? loan?.url),
      timestamp: true,
    }));
  } catch (error) { await replyError(interaction, error); }
};
