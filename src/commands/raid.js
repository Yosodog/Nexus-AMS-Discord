import { SlashCommandBuilder } from 'discord.js';
import { actorFromInteraction, collectionMessage, deferEphemeral, normalizeCollection, replyError } from '../utils/commandSupport.js';

export const data = new SlashCommandBuilder()
  .setName('raid').setDescription('Find recommended raid targets.')
  .addIntegerOption((option) => option.setName('nation').setDescription('Nation ID (staff may query another nation)').setMinValue(1))
  .addStringOption((option) => option.setName('sort').setDescription('Sort order').addChoices(
    { name: 'value', value: 'value' }, { name: 'cities', value: 'cities' }, { name: 'activity', value: 'activity' },
  ))
  .addIntegerOption((option) => option.setName('limit').setDescription('Number of targets').addChoices(
    { name: '5', value: 5 }, { name: '10', value: 10 },
  )).setDMPermission(false);

export const execute = async (interaction, context) => {
  await deferEphemeral(interaction);
  try {
    const filters = {
      nation_id: interaction.options.getInteger('nation') ?? undefined,
      sort: interaction.options.getString('sort') ?? 'value',
      limit: interaction.options.getInteger('limit') ?? 5,
    };
    const result = await context.apiService.getMyRaidAssignments(actorFromInteraction(interaction), filters);
    await interaction.editReply(collectionMessage({
      title: 'Raid Targets', collection: normalizeCollection(result), empty: 'No recommended targets found.',
      commandName: 'raid', userId: interaction.user.id,
    }));
  } catch (error) { await replyError(interaction, error); }
};
