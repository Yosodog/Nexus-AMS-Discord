import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { actorFromInteraction, replyError } from './commandSupport.js';

export const RESOURCE_KEYS = Object.freeze([
  'money', 'coal', 'oil', 'uranium', 'iron', 'bauxite', 'lead',
  'gasoline', 'munitions', 'steel', 'aluminum', 'food',
]);

const isDecimalString = (value) => /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value) && value !== '0';
const isWholeString = (value) => /^(?:0|[1-9]\d*)$/.test(value) && value !== '0';

const createId = (sessions, commandName, interaction, event, state = {}, oneShot = false) => sessions.create({
  commandName, userId: interaction.user.id, event, state, oneShot,
});

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
  const embed = new EmbedBuilder()
    .setTitle(`${kind === 'deposit' ? 'Deposit' : kind === 'war-aid' ? 'War Aid' : 'Withdrawal'} Resource Draft`)
    .setColor(0x5865f2)
    .setDescription('Choose up to five resources, then enter decimal amounts. Nexus validates balances, limits, and eligibility.');
  if (Object.keys(amounts).length) {
    embed.addFields({ name: 'Current draft', value: Object.entries(amounts).map(([key, value]) => `${key}: ${value}`).join('\n') });
  }
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select)], ephemeral: true };
};

export const showAmountModal = async (interaction, context) => {
  const { account, kind, note, amounts = {}, backendToken } = context.session.state;
  const fields = {};
  const rows = interaction.values.map((resource) => {
    const fieldId = createId(context.sessions, context.session.commandName, interaction, 'amount-field');
    fields[fieldId] = resource;
    return new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId(fieldId)
      .setLabel(`${resource} amount`)
      .setPlaceholder(kind === 'war-aid' ? 'Positive whole number' : 'Positive amount, for example 1250.50')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue(amounts[resource] ?? ''));
  });
  const modalId = createId(context.sessions, context.session.commandName, interaction, 'amounts-submitted', {
    account, kind, note, amounts, backendToken, fields,
  }, true);
  await interaction.showModal(new ModalBuilder()
    .setCustomId(modalId)
      .setTitle(`${kind === 'deposit' ? 'Deposit' : kind === 'war-aid' ? 'War Aid' : 'Withdrawal'} amounts`)
    .addComponents(...rows));
};

const reviewPayload = ({ interaction, context, state }) => {
  const rows = Object.entries(state.amounts).map(([resource, amount]) => `${resource}: ${amount}`);
  const editId = createId(context.sessions, context.session.commandName, interaction, 'edit-resources', state);
  const reviewId = createId(context.sessions, context.session.commandName, interaction, 'review', state, true);
  const cancelId = createId(context.sessions, context.session.commandName, interaction, 'cancel-local', state, true);
  return {
    embeds: [new EmbedBuilder().setTitle('Review Resource Draft').setColor(0xfee75c)
      .setDescription(rows.join('\n')).setFooter({ text: 'Amounts are sent as decimal strings. Nexus performs all calculations.' })],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(editId).setLabel('Add or change resources').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(reviewId).setLabel('Review').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(cancelId).setLabel('Cancel').setStyle(ButtonStyle.Danger),
    )],
  };
};

export const collectAmounts = async (interaction, context) => {
  const state = context.session.state;
  const amounts = { ...state.amounts };
  for (const [fieldId, resource] of Object.entries(state.fields)) {
    const value = interaction.fields.getTextInputValue(fieldId).trim();
    if (!(state.kind === 'war-aid' ? isWholeString(value) : isDecimalString(value))) {
      await interaction.reply({ content: `${resource} must be a positive ${state.kind === 'war-aid' ? 'whole number' : 'decimal with no more than 2 decimal places'}.`, ephemeral: true });
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
    await interaction.update({ content: 'Draft cancelled.', embeds: [], components: [] });
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
      const confirmId = createId(context.sessions, context.session.commandName, interaction, 'confirm-war-aid', { reviewToken }, true);
      await interaction.editReply({
        embeds: [new EmbedBuilder().setTitle('Confirm War Aid Request').setColor(0xfee75c)
          .setDescription(review.summary ?? 'Nexus validated the request. Confirm to submit it.')],
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
    const confirmId = createId(context.sessions, context.session.commandName, interaction, 'confirm', { intentToken }, true);
    const cancelId = createId(context.sessions, context.session.commandName, interaction, 'cancel', { intentToken }, true);
    await interaction.editReply({
      embeds: [new EmbedBuilder().setTitle('Confirm Withdrawal').setColor(0xfee75c)
        .setDescription(draft?.review?.requires_approval
          ? 'Nexus validated this withdrawal. It exceeds an existing withdrawal limit and will enter staff review after confirmation.'
          : 'Nexus validated this withdrawal for automatic sending. Confirm or cancel.')],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(confirmId).setLabel('Confirm').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(cancelId).setLabel('Cancel').setStyle(ButtonStyle.Danger),
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
    await interaction.editReply({ content: result?.message ?? 'War aid request submitted.', embeds: [], components: [] });
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
    await interaction.editReply({
      content: result?.message ?? (context.session.event === 'confirm' ? 'Withdrawal submitted.' : 'Withdrawal cancelled.'),
      embeds: [], components: [],
    });
  } catch (error) { await replyError(interaction, error); }
  return true;
};
