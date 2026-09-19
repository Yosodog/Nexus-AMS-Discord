import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import { actorFromInteraction, replyError } from '../utils/commandSupport.js';
import {
  buildEmbed,
  escapeMarkdown,
  formatDiscordTime,
  formatMoney,
  formatResources,
  statusLabel,
  statusMessage,
  titleCase,
  truncate,
} from '../utils/discordUi.js';

export const RESOURCE_SHORTFALL_CAPABILITY = 'alerts.resource-shortfall-actions.v1';

const CUSTOM_ID_PREFIX = 'nxs:rsa:';
const ACTION_CODES = Object.freeze({
  open: 'o',
  select: 's',
  confirm: 'c',
  cancel: 'x',
});
const OCCURRENCE_ACTIONS = new Set(['o', 's']);
const INTENT_ACTIONS = new Set(['c', 'x']);
const SNOWFLAKE = /^\d{17,20}$/;
const OCCURRENCE_ID = /^\d{1,20}$/;
const INTENT_TOKEN = /^[a-f0-9]{64}$/;

export const resourceShortfallCustomId = ({ action, guildId, occurrenceId, intentToken }) => {
  const code = ACTION_CODES[action];
  if (!code || !SNOWFLAKE.test(`${guildId ?? ''}`)) {
    throw new TypeError('Resource shortfall control requires a valid action and guild.');
  }
  const value = OCCURRENCE_ACTIONS.has(code) ? `${occurrenceId ?? ''}` : `${intentToken ?? ''}`;
  const validValue = OCCURRENCE_ACTIONS.has(code) ? OCCURRENCE_ID.test(value) : INTENT_TOKEN.test(value);
  if (!validValue) throw new TypeError('Resource shortfall control contains an invalid identifier.');
  const customId = `${CUSTOM_ID_PREFIX}${code}:${guildId}:${value}`;
  if (customId.length > 100) throw new TypeError('Resource shortfall control exceeds Discord limits.');
  return customId;
};

export const parseResourceShortfallCustomId = (customId) => {
  if (typeof customId !== 'string' || !customId.startsWith(CUSTOM_ID_PREFIX)) return null;
  const match = customId.match(/^nxs:rsa:([oscx]):(\d{17,20}):([a-z0-9]{1,64})$/);
  if (!match) return null;
  const [, action, guildId, value] = match;
  if (OCCURRENCE_ACTIONS.has(action) && !OCCURRENCE_ID.test(value)) return null;
  if (INTENT_ACTIONS.has(action) && !INTENT_TOKEN.test(value)) return null;
  return Object.freeze({
    action,
    guildId,
    occurrenceId: OCCURRENCE_ACTIONS.has(action) ? value : null,
    intentToken: INTENT_ACTIONS.has(action) ? value : null,
  });
};

const accountLabel = (account) => truncate(account?.account_name ?? `Account #${account?.account_id}`, 100);

const noOptionsMessage = () => statusMessage({
  title: 'Resources No Longer Actionable',
  tone: 'neutral',
  description: 'No single eligible Nexus account can currently fund the complete withdrawal. No intent was created and no funds were moved.',
  footer: 'Balances and the nation shortfall were recalculated by Nexus.',
});

const accountSelectorMessage = (control, accounts) => ({
  embeds: [buildEmbed({
    title: 'Choose a Nexus Account',
    tone: 'finance',
    description: 'Each option can fund the complete 12-turn withdrawal. Accounts will never be combined.',
    fields: accounts.slice(0, 25).map((account) => ({
      name: accountLabel(account),
      value: account.mode === 'mmr_purchase_withdrawal'
        ? `MMR-assisted · ${formatMoney(account.quoted_total)}`
        : 'Uses resources already held by this account',
      inline: false,
    })),
    footer: accounts.length > 25
      ? 'Discord can display only the first 25 eligible accounts.'
      : 'Nexus will revalidate the selected account before creating a preview.',
  })],
  components: [new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(resourceShortfallCustomId({
        action: 'select',
        guildId: control.guildId,
        occurrenceId: control.occurrenceId,
      }))
      .setPlaceholder('Choose one account')
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(accounts.slice(0, 25).map((account) => new StringSelectMenuOptionBuilder()
        .setLabel(accountLabel(account))
        .setDescription(account.mode === 'mmr_purchase_withdrawal'
          ? `MMR-assisted · ${formatMoney(account.quoted_total)}`
          : 'Use resources held by this account')
        .setValue(`${account.account_id}`))),
  )],
  ephemeral: true,
});

const purchaseResources = (lines) => Object.fromEntries(
  Object.entries(lines ?? {}).map(([resource, line]) => [resource, line?.qty ?? '0']),
);

const fulfillmentPreviewMessage = (control, draft) => {
  const fulfillment = draft?.fulfillment ?? {};
  const review = draft?.review ?? {};
  const account = draft?.account ?? {};
  const intentToken = `${fulfillment.id ?? ''}`;
  return {
    embeds: [buildEmbed({
      title: 'Confirm Resource Shortfall Fulfillment',
      tone: 'warning',
      description: review.requires_approval
        ? 'Nexus validated the full withdrawal. Confirmation will submit it for staff review.'
        : 'Nexus validated the full withdrawal. Confirmation will dispatch it through the normal bank workflow.',
      fields: [
        { name: 'Source account', value: escapeMarkdown(truncate(account.name ?? `Account #${account.id}`, 100)), inline: true },
        { name: 'Mode', value: fulfillment.mode === 'mmr_purchase_withdrawal' ? 'MMR-assisted purchase + withdrawal' : 'Account withdrawal', inline: true },
        { name: '12-turn withdrawal', value: formatResources(fulfillment.resources) },
        fulfillment.mode === 'mmr_purchase_withdrawal'
          ? { name: 'MMR resources purchased', value: formatResources(purchaseResources(fulfillment.purchase_lines)) }
          : null,
        fulfillment.mode === 'mmr_purchase_withdrawal'
          ? { name: 'Final purchase cost', value: formatMoney(fulfillment.quoted_total), inline: true }
          : null,
        review.pending_reason
          ? { name: 'Staff review reason', value: truncate(review.pending_reason, 500) }
          : null,
        fulfillment.expires_at
          ? { name: 'Quote expires', value: formatDiscordTime(fulfillment.expires_at), inline: true }
          : null,
      ],
      footer: fulfillment.mode === 'mmr_purchase_withdrawal'
        ? 'The MMR purchase becomes final on confirmation. A later denial returns resources, not the purchase charge.'
        : 'Nexus will revalidate the shortfall, balances, blockade, limits, and pending withdrawals on confirmation.',
    })],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(resourceShortfallCustomId({ action: 'confirm', guildId: control.guildId, intentToken }))
        .setLabel('Confirm')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(resourceShortfallCustomId({ action: 'cancel', guildId: control.guildId, intentToken }))
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary),
    )],
    ephemeral: true,
  };
};

const resultMessage = (result) => {
  const transaction = result?.transaction ?? {};
  const purchase = result?.purchase;
  const pendingReview = result?.fulfillment_status === 'pending_review';
  return statusMessage({
    title: pendingReview ? 'Withdrawal Submitted for Review' : 'Resources Dispatched',
    tone: pendingReview ? 'warning' : 'success',
    description: pendingReview
      ? 'Nexus created the complete withdrawal and routed it through the normal staff approval process.'
      : 'Nexus created and dispatched the complete withdrawal through the normal bank process.',
    fields: [
      transaction.id ? { name: 'Transaction', value: `#${transaction.id}`, inline: true } : null,
      { name: 'Status', value: statusLabel(result?.fulfillment_status), inline: true },
      transaction.resources ? { name: 'Resources', value: formatResources(transaction.resources) } : null,
      purchase ? { name: 'MMR purchase', value: `#${purchase.id} · ${formatMoney(purchase.total_spent)}`, inline: true } : null,
      purchase ? { name: 'Purchase status', value: 'Final', inline: true } : null,
    ],
    footer: purchase
      ? 'If this withdrawal is later denied or refunded, its resources return to the Nexus account; the MMR charge remains final.'
      : 'The normal Nexus withdrawal, audit, and refund rules apply.',
  });
};

const draftForAccount = async (interaction, context, control, accountId) => {
  const actor = actorFromInteraction(interaction, 'resource-shortfall');
  const draft = await context.apiService.createResourceShortfallDraft(
    actor,
    control.occurrenceId,
    accountId,
  );
  await interaction.editReply(fulfillmentPreviewMessage(control, draft));
};

export const handleResourceShortfallInteraction = async (interaction, context) => {
  const control = context.resourceShortfallControl;
  const actor = actorFromInteraction(interaction, 'resource-shortfall');
  try {
    if (control.action === 'o') {
      await interaction.deferReply({ ephemeral: true });
      const options = await context.apiService.getResourceShortfallOptions(actor, control.occurrenceId);
      const accounts = Array.isArray(options?.accounts) ? options.accounts : [];
      if (accounts.length === 0) {
        await interaction.editReply(noOptionsMessage());
      } else if (accounts.length === 1) {
        await draftForAccount(interaction, context, control, accounts[0].account_id);
      } else {
        await interaction.editReply(accountSelectorMessage(control, accounts));
      }
      return;
    }

    if (control.action === 's') {
      await interaction.deferUpdate();
      const accountId = `${interaction.values?.[0] ?? ''}`;
      if (!/^\d{1,20}$/.test(accountId)) throw new TypeError('Choose a valid Nexus account.');
      await draftForAccount(interaction, context, control, accountId);
      return;
    }

    await interaction.deferUpdate();
    if (control.action === 'c') {
      const result = await context.apiService.confirmResourceShortfallFulfillment(actor, control.intentToken);
      await interaction.editReply(resultMessage(result));
      return;
    }
    if (control.action === 'x') {
      await context.apiService.cancelResourceShortfallFulfillment(actor, control.intentToken);
      await interaction.editReply(statusMessage({
        title: 'Resource Fulfillment Cancelled',
        tone: 'neutral',
        description: 'The fulfillment preview was cancelled. No purchase or withdrawal was created.',
      }));
      return;
    }
    throw new TypeError(`Unsupported resource shortfall action: ${titleCase(control.action)}`);
  } catch (error) {
    await replyError(interaction, error, 'Resource Fulfillment Failed');
  }
};
