import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import {
  accountChoices, actorFromInteraction, collectionMessage, deferEphemeral, executeAutocomplete,
  normalizeCollection, replyError,
} from '../utils/commandSupport.js';

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
    const confirmId = context.sessions.create({ commandName: 'rebuild', userId: interaction.user.id,
      event: 'confirm', state: payload, oneShot: true });
    const cancelId = context.sessions.create({ commandName: 'rebuild', userId: interaction.user.id,
      event: 'cancel', state: {}, oneShot: true });
    await interaction.editReply({
      embeds: [new EmbedBuilder().setTitle('Rebuilding Estimate').setColor(0xfee75c)
        .setDescription(preview.summary ?? 'Nexus calculated an eligible rebuilding estimate.')],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(confirmId).setLabel('Submit request').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(cancelId).setLabel('Cancel').setStyle(ButtonStyle.Danger),
      )],
    });
  } catch (error) { await replyError(interaction, error); }
};

export const button = async (interaction, context) => {
  if (context.session.event === 'cancel') {
    await interaction.update({ content: 'Rebuilding request cancelled.', embeds: [], components: [] });
    return;
  }
  await interaction.deferUpdate();
  try {
    const result = await context.apiService.confirmRebuildRequest(actorFromInteraction(interaction), {
      account_id: context.session.state.account_id,
      note: context.session.state.note,
    });
    await interaction.editReply({ content: result?.message ?? 'Rebuilding request submitted.', embeds: [], components: [] });
  } catch (error) { await replyError(interaction, error); }
};
