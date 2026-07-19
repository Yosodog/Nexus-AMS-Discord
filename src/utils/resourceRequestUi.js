import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { actorFromInteraction, replyError } from './commandSupport.js';
import {
  buildEmbed, formatDiscordTime, formatResources, resolveDeepLink, statusLabel, statusMessage, truncate,
} from './discordUi.js';

export const RESOURCE_KEYS = Object.freeze([
  'money', 'coal', 'oil', 'uranium', 'iron', 'bauxite', 'lead',
  'gasoline', 'munitions', 'steel', 'aluminum', 'food',
]);

const isDecimalString = (value) => /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value) && value !== '0';
const isWholeString = (value) => /^(?:0|[1-9]\d*)$/.test(value) && value !== '0';

const createId = (sessions, commandName, interaction, event, state = {}, oneShot = false) => sessions.create({
  commandName, userId: interaction.user.id, event, state, oneShot,
});

const requestLabel = (kind) => (kind === 'deposit' ? 'Deposit' : kind === 'war-aid' ? 'War Aid' : 'Withdrawal');
const accountLabel = (account) => `Account #${truncate(account, 64)}`;

export const resourcePickerPayload = ({ commandName, interaction, sessions, account, kind, note, amounts = {}, backendToken }) => {
  const selectId = createId(sessions, commandName, interaction, 'resources-selected', {
    account, kind, note, amounts, backendToken,
  }, true);
  const select = new StringSelectMenuBuilder()
    .setCustomId(selectId)
    .setPlaceholder('Choose up to 5 resources')
    .setMinValues(1).setMaxValues(5)
    .addOptions(RESOURCE_KEYS.map((resource) => new StringSelectMenuOptionBuilder()
      .setLabel(resource[0].toUpperCase() + resource.slice(1))
      .setValue(resource)
      .setDefault(Boolean(amounts[resource]))));
  const embed = buildEmbed({
    title: `${requestLabel(kind)} Resource Draft`,
    tone: 'info',
    description: kind === 'war-aid'
      ? 'Choose up to five resources, then enter positive whole-number amounts. Nexus validates eligibility before submission.'
      : 'Choose up to five resources, then enter positive amounts with up to two decimal places. Nexus validates balances and limits.',
    fields: [
      { name: kind === 'withdrawal' ? 'Source account' : 'Destination account', value: accountLabel(account), inline: true },
      note ? { name: 'Note', value: truncate(note, 500) } : null,
      Object.keys(amounts).length
        ? { name: 'Current draft', value: formatResources(amounts) }
        : null,
    ],
    footer: 'Select resources to continue. You can return here before the request is submitted.',
  });
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select)], ephemeral: true };
};

export const showAmountModal = async (interaction, context) => {
  const { account, kind, note, amounts = {}, backendToken } = context.session.state;
  const fields = {};
  const selectedAmounts = Object.fromEntries(interaction.values
    .filter((resource) => amounts[resource] !== undefined)
    .map((resource) => [resource, amounts[resource]]));
  const maxLength = kind === 'war-aid' ? 13 : 16;
  const rows = interaction.values.map((resource) => {
    const fieldId = createId(context.sessions, context.session.commandName, interaction, 'amount-field');
    fields[fieldId] = resource;
    return new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId(fieldId)
      .setLabel(`${resource} amount`)
      .setPlaceholder(kind === 'war-aid' ? 'Positive whole number' : 'Positive amount, for example 1250.50')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(maxLength)
      .setValue(selectedAmounts[resource] ?? ''));
  });
  const modalId = createId(context.sessions, context.session.commandName, interaction, 'amounts-submitted', {
    account, kind, note, amounts: selectedAmounts, backendToken, fields,
  }, true);
  await interaction.showModal(new ModalBuilder()
    .setCustomId(modalId)
    .setTitle(`${requestLabel(kind)} amounts`)
    .addComponents(...rows));
};

const reviewPayload = ({ interaction, context, state }) => {
  const editId = createId(context.sessions, context.session.commandName, interaction, 'edit-resources', state);
  const reviewId = createId(context.sessions, context.session.commandName, interaction, 'review', state, true);
  const cancelId = createId(context.sessions, context.session.commandName, interaction, 'cancel-local', state, true);
  return {
    embeds: [buildEmbed({
      title: `Review ${requestLabel(state.kind)} Draft`,
      tone: 'warning',
      description: 'Check the account and amounts before asking Nexus to validate the draft.',
      fields: [
        {
          name: state.kind === 'withdrawal' ? 'Source account' : 'Destination account',
          value: accountLabel(state.account),
          inline: true,
        },
        state.note ? { name: 'Note', value: truncate(state.note, 500) } : null,
        { name: 'Resources', value: formatResources(state.amounts) },
      ],
      footer: 'Amounts remain decimal strings in the API payload; Nexus performs all calculations.',
    })],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(editId).setLabel('Add or change resources').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(reviewId).setLabel('Review').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(cancelId).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    )],
  };
};

export const collectAmounts = async (interaction, context) => {
  const state = context.session.state;
  const amounts = {};
  for (const [fieldId, resource] of Object.entries(state.fields)) {
    const value = interaction.fields.getTextInputValue(fieldId).trim();
    if (!(state.kind === 'war-aid' ? isWholeString(value) : isDecimalString(value))) {
      await interaction.reply({
        ...statusMessage({
          title: `Invalid ${resource} Amount`,
          tone: 'danger',
          description: `${resource} must be a positive ${state.kind === 'war-aid' ? 'whole number' : 'decimal with no more than two decimal places'}.`,
        }),
        ephemeral: true,
      });
      return;
    }
    amounts[resource] = value;
  }
  await interaction.reply({ ...reviewPayload({ interaction, context, state: { ...state, amounts } }), ephemeral: true });
};

export const handleResourceButton = async (interaction, context) => {
  const { event, state } = context.session;
  if (event === 'edit-resources') {
    await interaction.update(resourcePickerPayload({
      commandName: context.session.commandName, interaction, sessions: context.sessions, ...state,
    }));
    return;
  }
  if (event === 'cancel-local') {
    await interaction.update(statusMessage({
      title: `${requestLabel(state.kind)} Draft Cancelled`,
      tone: 'neutral',
      description: 'No request was submitted to Nexus.',
    }));
    return;
  }
  if (event !== 'review') return;

  await interaction.deferUpdate();
  try {
    const actor = actorFromInteraction(interaction);
    if (state.kind === 'war-aid') {
      const resources = Object.fromEntries(RESOURCE_KEYS.map((key) => [key, state.amounts[key] ?? '0']));
      const draft = await context.apiService.createWarAidDraft(actor, {
        account_id: Number(state.account), note: state.note, ...resources,
      });
      const intentToken = `${draft?.intent?.id ?? ''}`;
      if (!intentToken) throw new TypeError('War aid draft is missing an opaque token.');
      const review = await context.apiService.reviewWarAidDraft(actor, { intent_id: intentToken });
      const reviewToken = `${review?.intent?.id ?? intentToken}`;
      if (!reviewToken) throw new TypeError('War aid review is missing an opaque token.');
      const authoritativeResources = review?.resources ?? resources;
      const authoritativeAccount = review?.account_id ?? state.account;
      const authoritativeNote = review?.note ?? state.note;
      const confirmId = createId(context.sessions, context.session.commandName, interaction, 'confirm-war-aid', {
        reviewToken,
        account: authoritativeAccount,
        note: authoritativeNote,
        amounts: authoritativeResources,
      }, true);
      await interaction.editReply({
        embeds: [buildEmbed({
          title: 'Confirm War Aid Request',
          tone: 'warning',
          description: truncate(
            review?.summary ?? 'Nexus validated the request. Confirm to submit it for review.',
            1200,
          ),
          fields: [
            { name: 'Destination account', value: accountLabel(authoritativeAccount), inline: true },
            authoritativeNote ? { name: 'Note', value: truncate(authoritativeNote, 500) } : null,
            { name: 'Validated resources', value: formatResources(authoritativeResources) },
            review?.intent?.expires_at
              ? { name: 'Review expires', value: formatDiscordTime(review.intent.expires_at), inline: true }
              : null,
          ],
          footer: 'These amounts came from the Nexus review response.',
        })],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(confirmId).setLabel('Confirm request').setStyle(ButtonStyle.Success),
        )],
      });
      return;
    }

    const resources = Object.fromEntries(RESOURCE_KEYS.map((key) => [key, state.amounts[key] ?? '0']));
    const draft = await context.apiService.createWithdrawalDraft(actor, {
      account_id: Number(state.account), resources,
    });
    const intentToken = `${draft?.withdrawal?.id ?? ''}`;
    if (!intentToken) throw new TypeError('Withdrawal draft response is missing an opaque intent token.');
    const authoritativeResources = draft?.withdrawal?.resources ?? resources;
    const authoritativeAccount = draft?.withdrawal?.account_id ?? state.account;
    const decisionState = { intentToken, account: authoritativeAccount, amounts: authoritativeResources };
    const confirmId = createId(context.sessions, context.session.commandName, interaction, 'confirm', decisionState, true);
    const cancelId = createId(context.sessions, context.session.commandName, interaction, 'cancel', decisionState, true);
    await interaction.editReply({
      embeds: [buildEmbed({
        title: 'Confirm Withdrawal',
        tone: 'warning',
        description: draft?.review?.requires_approval
          ? 'Nexus validated this withdrawal. It exceeds an automatic withdrawal limit and will enter staff review after confirmation.'
          : 'Nexus validated this withdrawal for automatic sending. Confirm or cancel.',
        fields: [
          { name: 'Source account', value: accountLabel(authoritativeAccount), inline: true },
          draft?.withdrawal?.status
            ? { name: 'Draft status', value: statusLabel(draft.withdrawal.status), inline: true }
            : null,
          { name: 'Validated resources', value: formatResources(authoritativeResources) },
          draft?.review?.pending_reason
            ? { name: 'Staff review reason', value: truncate(draft.review.pending_reason, 500) }
            : null,
          draft?.withdrawal?.expires_at
            ? { name: 'Draft expires', value: formatDiscordTime(draft.withdrawal.expires_at), inline: true }
            : null,
        ],
        footer: 'These normalized amounts came from the Nexus withdrawal draft.',
      })],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(confirmId).setLabel('Confirm').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(cancelId).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
      )],
    });
  } catch (error) { await replyError(interaction, error); }
};

export const handleWarAidDecision = async (interaction, context) => {
  if (context.session.event !== 'confirm-war-aid') return false;
  await interaction.deferUpdate();
  try {
    const result = await context.apiService.confirmWarAidRequest(actorFromInteraction(interaction), {
      intent_id: context.session.state.reviewToken,
    });
    await interaction.editReply(statusMessage({
      title: 'War Aid Request Submitted',
      tone: 'success',
      description: truncate(result?.message ?? 'Nexus accepted the war aid request for staff review.', 1200),
      fields: [
        result?.id !== undefined ? { name: 'Request', value: `#${result.id}`, inline: true } : null,
        context.session.state.account !== undefined
          ? { name: 'Destination account', value: accountLabel(context.session.state.account), inline: true }
          : null,
        result?.status ? { name: 'Status', value: statusLabel(result.status), inline: true } : null,
        context.session.state.note
          ? { name: 'Note', value: truncate(context.session.state.note, 500) }
          : null,
        context.session.state.amounts
          ? { name: 'Resources', value: formatResources(context.session.state.amounts) }
          : null,
        result?.created_at
          ? { name: 'Submitted', value: formatDiscordTime(result.created_at), inline: true }
          : null,
      ],
      url: resolveDeepLink(context.apiService.baseUrl, result?.deep_link_path ?? result?.url),
      timestamp: true,
    }));
  } catch (error) { await replyError(interaction, error); }
  return true;
};

export const handleWithdrawalDecision = async (interaction, context) => {
  if (!['confirm', 'cancel'].includes(context.session.event)) return false;
  await interaction.deferUpdate();
  try {
    const actor = actorFromInteraction(interaction);
    const result = context.session.event === 'confirm'
      ? await context.apiService.confirmWithdrawal(actor, context.session.state.intentToken)
      : await context.apiService.cancelWithdrawal(actor, context.session.state.intentToken);
    const confirmed = context.session.event === 'confirm';
    const withdrawal = result?.withdrawal ?? {};
    const transaction = result?.transaction ?? {};
    const authoritativeResources = transaction?.resources ?? withdrawal?.resources ?? context.session.state.amounts;
    const authoritativeAccount = withdrawal?.account_id ?? context.session.state.account;
    const status = transaction?.status ?? withdrawal?.status;
    await interaction.editReply(statusMessage({
      title: confirmed ? 'Withdrawal Submitted' : 'Withdrawal Cancelled',
      tone: confirmed ? 'success' : 'neutral',
      description: truncate(
        result?.message ?? (confirmed
          ? 'Nexus accepted the withdrawal for processing.'
          : 'The withdrawal draft was cancelled before funds were sent.'),
        1200,
      ),
      fields: [
        authoritativeAccount !== undefined
          ? { name: 'Source account', value: accountLabel(authoritativeAccount), inline: true }
          : null,
        transaction?.id !== undefined
          ? { name: 'Transaction', value: `#${transaction.id}`, inline: true }
          : null,
        status ? { name: 'Status', value: statusLabel(status), inline: true } : null,
        authoritativeResources
          ? { name: confirmed ? 'Submitted resources' : 'Cancelled resources', value: formatResources(authoritativeResources) }
          : null,
        transaction?.created_at
          ? { name: 'Submitted', value: formatDiscordTime(transaction.created_at), inline: true }
          : null,
        !confirmed && withdrawal?.canceled_at
          ? { name: 'Cancelled', value: formatDiscordTime(withdrawal.canceled_at), inline: true }
          : null,
      ],
      timestamp: true,
    }));
  } catch (error) { await replyError(interaction, error); }
  return true;
};
