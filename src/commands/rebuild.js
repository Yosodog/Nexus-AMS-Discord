import { ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder } from 'discord.js';
import {
  accountChoices, actorFromInteraction, collectionMessage, deferEphemeral, executeAutocomplete,
  normalizeCollection, replyError,
} from '../utils/commandSupport.js';
import {
  buildEmbed, formatDiscordTime, formatMoney, resolveDeepLink, statusLabel, statusMessage, truncate,
} from '../utils/discordUi.js';

export const data = new SlashCommandBuilder().setName('rebuild').setDescription('Request rebuilding support.')
  .addSubcommand((sub) => sub.setName('apply').setDescription('Preview and request rebuilding support.')
    .addStringOption((option) => option.setName('account').setDescription('Destination account').setRequired(true).setAutocomplete(true))
    .addStringOption((option) => option.setName('note').setDescription('Optional note').setMaxLength(255)))
  .addSubcommand((sub) => sub.setName('status').setDescription('View your rebuilding requests.'))
  .setDMPermission(false);
export const autocomplete = (interaction, { apiService }) => executeAutocomplete(interaction, apiService, accountChoices);

export const execute = async (interaction, context) => {
  await deferEphemeral(interaction);
  try {
    if (interaction.options.getSubcommand() === 'status') {
      const result = await context.apiService.getMyRebuildRequests(actorFromInteraction(interaction));
      await interaction.editReply(collectionMessage({
        title: 'Your Rebuilding Requests', collection: normalizeCollection(result),
        empty: 'No rebuilding requests found.', commandName: 'rebuild', userId: interaction.user.id,
        sessions: context.sessions, variant: 'request', baseUrl: context.apiService.baseUrl,
        description: 'Rebuilding support requests submitted by your nation, newest first.',
      }));
      return;
    }
    const payload = {
      account_id: Number(interaction.options.getString('account', true)),
      note: interaction.options.getString('note') ?? undefined,
    };
    const preview = await context.apiService.previewRebuildRequest(actorFromInteraction(interaction), payload);
    if (!preview?.enabled || !preview?.eligible) {
      throw Object.assign(new Error(preview?.reason ?? 'This nation is not eligible for rebuilding support.'), { code: 'VALIDATION_ERROR' });
    }
    const selectedAccount = preview?.accounts?.find((account) => Number(account.id) === payload.account_id);
    const accountName = selectedAccount?.name;
    const estimatedAmount = preview?.estimated_amount;
    const confirmId = context.sessions.create({ commandName: 'rebuild', userId: interaction.user.id,
      event: 'confirm', state: { ...payload, accountName, estimatedAmount }, oneShot: true });
    const cancelId = context.sessions.create({ commandName: 'rebuild', userId: interaction.user.id,
      event: 'cancel', state: {}, oneShot: true });
    await interaction.editReply({
      embeds: [buildEmbed({
        title: 'Review Rebuilding Request',
        tone: 'warning',
        description: truncate(
          preview?.summary ?? 'Nexus calculated an eligible rebuilding estimate. Review the destination before submitting.',
          1200,
        ),
        fields: [
          {
            name: 'Destination account',
            value: accountName ? `${truncate(accountName, 100)} (#${payload.account_id})` : `Account #${payload.account_id}`,
            inline: true,
          },
          estimatedAmount !== undefined && estimatedAmount !== null
            ? { name: 'Estimated support', value: formatMoney(estimatedAmount), inline: true }
            : null,
          preview?.city_count !== undefined
            ? { name: 'Cities evaluated', value: `${preview.city_count}`, inline: true }
            : null,
          preview?.cycle_id !== undefined
            ? { name: 'Rebuilding cycle', value: `${preview.cycle_id}`, inline: true }
            : null,
          payload.note ? { name: 'Note', value: truncate(payload.note, 500) } : null,
        ],
        footer: 'The estimate is calculated by Nexus and will be revalidated when submitted.',
      })],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(confirmId).setLabel('Submit request').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(cancelId).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
      )],
    });
  } catch (error) { await replyError(interaction, error); }
};

export const button = async (interaction, context) => {
  if (context.session.event === 'cancel') {
    await interaction.update(statusMessage({
      title: 'Rebuilding Draft Cancelled',
      tone: 'neutral',
      description: 'No rebuilding request was submitted.',
    }));
    return;
  }
  await interaction.deferUpdate();
  try {
    const result = await context.apiService.confirmRebuildRequest(actorFromInteraction(interaction), {
      account_id: context.session.state.account_id,
      note: context.session.state.note,
    });
    const accountLabel = context.session.state.accountName
      ? `${truncate(context.session.state.accountName, 100)} (#${context.session.state.account_id})`
      : `Account #${context.session.state.account_id}`;
    await interaction.editReply(statusMessage({
      title: 'Rebuilding Request Submitted',
      tone: 'success',
      description: truncate(result?.message ?? 'Nexus accepted the rebuilding request for staff review.', 1200),
      fields: [
        result?.id !== undefined ? { name: 'Request', value: `#${result.id}`, inline: true } : null,
        { name: 'Destination account', value: accountLabel, inline: true },
        context.session.state.estimatedAmount !== undefined && context.session.state.estimatedAmount !== null
          ? { name: 'Estimated support', value: formatMoney(context.session.state.estimatedAmount), inline: true }
          : null,
        result?.status ? { name: 'Status', value: statusLabel(result.status), inline: true } : null,
        context.session.state.note
          ? { name: 'Note', value: truncate(context.session.state.note, 500) }
          : null,
        result?.created_at
          ? { name: 'Submitted', value: formatDiscordTime(result.created_at), inline: true }
          : null,
      ],
      url: resolveDeepLink(context.apiService.baseUrl, result?.deep_link_path ?? result?.url),
      timestamp: true,
    }));
  } catch (error) { await replyError(interaction, error); }
};
