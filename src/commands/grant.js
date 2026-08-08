import { ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder } from 'discord.js';
import {
  accountChoices, actorFromInteraction, collectionMessage, deferEphemeral, executeAutocomplete,
  normalizeCollection, replyError,
} from '../utils/commandSupport.js';
import {
  buildEmbed, formatDiscordTime, formatMoney, resolveDeepLink, statusLabel, statusMessage, truncate,
} from '../utils/discordUi.js';

export const data = new SlashCommandBuilder().setName('grant').setDescription('Browse and apply for Nexus grants.')
  .addSubcommand((sub) => sub.setName('browse').setDescription('Browse grant programs.')
    .addBooleanOption((option) => option.setName('eligible_only').setDescription('Only show programs Nexus says you are eligible for.')))
  .addSubcommand((sub) => sub.setName('apply').setDescription('Apply for a grant.')
    .addStringOption((option) => option.setName('grant').setDescription('Grant program').setRequired(true).setAutocomplete(true))
    .addStringOption((option) => option.setName('account').setDescription('Destination account').setRequired(true).setAutocomplete(true)))
  .addSubcommand((sub) => sub.setName('city').setDescription('Apply for the current city grant.')
    .addStringOption((option) => option.setName('account').setDescription('Destination account').setRequired(true).setAutocomplete(true)))
  .addSubcommand((sub) => sub.setName('status').setDescription('View your grant requests.'))
  .setDMPermission(false);

export const help = Object.freeze({
  audience: 'Members',
  topic: Object.freeze(['member', 'finance']),
  examples: Object.freeze(['/grant browse', '/grant apply grant:<grant> account:<account>', '/grant status']),
  related: Object.freeze(['accounts', 'deposit', 'loan']),
});

const grantChoices = async (interaction, apiService) => {
  const query = interaction.options.getFocused()?.trim?.() ?? '';
  const result = await apiService.getGrantPrograms(actorFromInteraction(interaction), { query, limit: 25 });
  return normalizeCollection(result).items.slice(0, 25).map((grant) => ({
    name: `${grant.name ?? grant.label ?? 'Grant'}`.slice(0, 100),
    value: `${grant.token ?? grant.id}`.slice(0, 100),
  }));
};

export const autocomplete = (interaction, { apiService }) => {
  const focused = interaction.options.getFocused(true);
  return executeAutocomplete(interaction, apiService, focused.name === 'grant' ? grantChoices : accountChoices);
};

export const execute = async (interaction, context) => {
  await deferEphemeral(interaction);
  const actor = actorFromInteraction(interaction);
  const subcommand = interaction.options.getSubcommand();
  try {
    if (subcommand === 'browse') {
      const eligibleOnly = interaction.options.getBoolean('eligible_only') ?? false;
      const result = await context.apiService.getGrantPrograms(actor, {
        eligible_only: eligibleOnly,
      });
      await interaction.editReply(collectionMessage({
        title: 'Grant Programs', collection: normalizeCollection(result), empty: 'No matching grant programs.',
        commandName: 'grant', userId: interaction.user.id, sessions: context.sessions,
        variant: 'grant-program', baseUrl: context.apiService.baseUrl,
        description: eligibleOnly
          ? 'Programs Nexus currently marks your nation eligible to request.'
          : 'Enabled grant programs, including current eligibility guidance.',
      }));
      return;
    }
    if (subcommand === 'status') {
      const result = await context.apiService.getMyGrantRequests(actor);
      await interaction.editReply(collectionMessage({
        title: 'Your Grant Requests', collection: normalizeCollection(result), empty: 'No grant requests found.',
        commandName: 'grant', userId: interaction.user.id, sessions: context.sessions,
        variant: 'request', baseUrl: context.apiService.baseUrl,
        description: 'Grant requests submitted by your nation, newest first.',
      }));
      return;
    }
    const request = {
      grant_id: subcommand === 'apply' ? Number(interaction.options.getString('grant', true)) : undefined,
      account_id: Number(interaction.options.getString('account', true)),
    };
    const preview = subcommand === 'city'
      ? await context.apiService.previewCityGrantRequest(actor, request)
      : await context.apiService.previewGrantApplication(actor, request);
    const previewToken = `${preview?.intent?.id ?? ''}`;
    if (!previewToken) throw new TypeError('Grant preview is missing an opaque token.');
    const accountId = preview?.account_id ?? request.account_id;
    const estimatedAmount = preview?.estimated_grant_amount;
    const previewState = {
      type: subcommand,
      previewToken,
      accountId,
      grantId: request.grant_id,
      cityNumber: preview?.city_number,
      estimatedAmount,
    };
    const confirmId = context.sessions.create({ commandName: 'grant', userId: interaction.user.id,
      event: 'confirm', state: previewState, oneShot: true });
    await interaction.editReply({
      embeds: [buildEmbed({
        title: 'Review Grant Request',
        tone: 'warning',
        description: truncate(
          preview?.summary ?? 'Nexus validated this grant request. Confirm to submit it.',
          1200,
        ),
        fields: [
          { name: 'Destination account', value: `Account #${accountId}`, inline: true },
          subcommand === 'city'
            ? (preview?.city_number !== undefined
              ? { name: 'City', value: `City ${preview.city_number}`, inline: true }
              : { name: 'Request type', value: 'Current city grant', inline: true })
            : { name: 'Grant program', value: `Program #${request.grant_id}`, inline: true },
          estimatedAmount !== undefined && estimatedAmount !== null
            ? { name: 'Estimated grant', value: formatMoney(estimatedAmount), inline: true }
            : null,
          preview?.intent?.expires_at
            ? { name: 'Preview expires', value: formatDiscordTime(preview.intent.expires_at), inline: true }
            : null,
        ],
        footer: 'Nexus will revalidate eligibility when you confirm.',
      })],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(confirmId).setLabel('Confirm request').setStyle(ButtonStyle.Success),
      )],
    });
  } catch (error) { await replyError(interaction, error); }
};

export const button = async (interaction, context) => {
  await interaction.deferUpdate();
  try {
    const { type, previewToken } = context.session.state;
    const payload = { intent_id: previewToken };
    const result = type === 'city'
      ? await context.apiService.confirmCityGrantRequest(actorFromInteraction(interaction), payload)
      : await context.apiService.confirmGrantApplication(actorFromInteraction(interaction), payload);
    await interaction.editReply(statusMessage({
      title: type === 'city' ? 'City Grant Request Submitted' : 'Grant Request Submitted',
      tone: 'success',
      description: truncate(result?.message ?? 'Nexus accepted the request for processing.', 1200),
      fields: [
        result?.id !== undefined ? { name: 'Request', value: `#${result.id}`, inline: true } : null,
        context.session.state.accountId !== undefined
          ? { name: 'Destination account', value: `Account #${context.session.state.accountId}`, inline: true }
          : null,
        context.session.state.estimatedAmount !== undefined && context.session.state.estimatedAmount !== null
          ? { name: 'Estimated grant', value: formatMoney(context.session.state.estimatedAmount), inline: true }
          : null,
        result?.status ? { name: 'Status', value: statusLabel(result.status), inline: true } : null,
        result?.created_at
          ? { name: 'Submitted', value: formatDiscordTime(result.created_at), inline: true }
          : null,
      ],
      url: resolveDeepLink(context.apiService.baseUrl, result?.deep_link_path ?? result?.url),
      timestamp: true,
    }));
  } catch (error) { await replyError(interaction, error); }
};
