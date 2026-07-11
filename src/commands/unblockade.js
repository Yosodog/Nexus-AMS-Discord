import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import {
  actorFromInteraction, collectionMessage, deferEphemeral, normalizeCollection, replyError,
} from '../utils/commandSupport.js';

export const data = new SlashCommandBuilder()
  .setName('unblockade')
  .setDescription('Coordinate alliance blockade relief.')
  .addSubcommand((sub) => sub.setName('request').setDescription('Request help breaking an active blockade.')
    .addIntegerOption((option) => option.setName('war').setDescription('Active war ID').setRequired(true).setMinValue(1))
    .addIntegerOption((option) => option.setName('deadline').setDescription('Hours until this request expires')
      .addChoices(
        { name: '2 hours', value: 2 }, { name: '4 hours', value: 4 }, { name: '6 hours', value: 6 },
        { name: '12 hours', value: 12 }, { name: '24 hours', value: 24 },
      ))
    .addStringOption((option) => option.setName('note').setDescription('Optional coordination context').setMaxLength(255)))
  .addSubcommand((sub) => sub.setName('mine').setDescription('View your blockade relief requests.'))
  .addSubcommand((sub) => sub.setName('available').setDescription('View relief requests you can currently claim.'))
  .addSubcommand((sub) => sub.setName('claim').setDescription('Claim an eligible relief request.')
    .addIntegerOption((option) => option.setName('request').setDescription('Relief request ID').setRequired(true).setMinValue(1)))
  .addSubcommand((sub) => sub.setName('cancel').setDescription('Cancel one of your active relief requests.')
    .addIntegerOption((option) => option.setName('request').setDescription('Relief request ID').setRequired(true).setMinValue(1)))
  .setDMPermission(false);

const requestCollection = (result) => normalizeCollection(result?.requests ?? result);

export const execute = async (interaction, context) => {
  await deferEphemeral(interaction);
  const actor = actorFromInteraction(interaction);
  const subcommand = interaction.options.getSubcommand();

  try {
    if (subcommand === 'request') {
      const result = await context.apiService.requestDiscord('me/blockade-relief', {
        method: 'post',
        actor,
        data: {
          war_id: interaction.options.getInteger('war', true),
          deadline_hours: interaction.options.getInteger('deadline') ?? 6,
          note: interaction.options.getString('note')?.trim() || null,
        },
      });
      await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('Relief Request Opened').setColor(0x57f287)
        .setDescription(`Request #${result.id} is open until <t:${Math.floor(new Date(result.deadline_at).getTime() / 1000)}:R>.`)] });
      return;
    }

    if (subcommand === 'claim' || subcommand === 'cancel') {
      const id = interaction.options.getInteger('request', true);
      const result = await context.apiService.requestDiscord(`me/blockade-relief/${id}/${subcommand}`, {
        method: 'post', actor, data: {},
      });
      await interaction.editReply({ embeds: [new EmbedBuilder()
        .setTitle(subcommand === 'claim' ? 'Relief Request Claimed' : 'Relief Request Cancelled')
        .setColor(subcommand === 'claim' ? 0x57f287 : 0xfee75c)
        .setDescription(`Request #${result.id} is now ${result.status}. Recheck the war in Nexus before acting.`)] });
      return;
    }

    const path = subcommand === 'available' ? 'me/blockade-relief/available' : 'me/blockade-relief';
    const result = await context.apiService.requestDiscord(path, { actor });
    const collection = requestCollection(result);
    await interaction.editReply(collectionMessage({
      title: subcommand === 'available' ? 'Available Blockade Relief' : 'Your Blockade Relief Requests',
      collection,
      empty: subcommand === 'available' ? 'No current requests match your nation.' : 'You have no blockade relief requests.',
      commandName: 'unblockade',
      userId: interaction.user.id,
    }));
  } catch (error) {
    await replyError(interaction, error);
  }
};
