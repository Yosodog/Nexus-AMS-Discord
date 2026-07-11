import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import {
  accountChoices, actorFromInteraction, collectionMessage, deferEphemeral, executeAutocomplete,
  normalizeCollection, replyError,
} from '../utils/commandSupport.js';

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
      const result = await context.apiService.getGrantPrograms(actor, {
        eligible_only: interaction.options.getBoolean('eligible_only') ?? false,
      });
      await interaction.editReply(collectionMessage({
        title: 'Grant Programs', collection: normalizeCollection(result), empty: 'No matching grant programs.',
        commandName: 'grant', userId: interaction.user.id,
      }));
      return;
    }
    if (subcommand === 'status') {
      const result = await context.apiService.getMyGrantRequests(actor);
      await interaction.editReply(collectionMessage({
        title: 'Your Grant Requests', collection: normalizeCollection(result), empty: 'No grant requests found.',
        commandName: 'grant', userId: interaction.user.id,
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
    const confirmId = context.sessions.create({ commandName: 'grant', userId: interaction.user.id,
      event: 'confirm', state: { type: subcommand, previewToken }, oneShot: true });
    await interaction.editReply({
      embeds: [new EmbedBuilder().setTitle('Review Grant Request').setColor(0xfee75c)
        .setDescription(preview?.summary ?? 'Nexus validated this grant request. Confirm to submit it.')],
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
    await interaction.editReply({ content: result?.message ?? 'Grant request submitted.', embeds: [], components: [] });
  } catch (error) { await replyError(interaction, error); }
};
