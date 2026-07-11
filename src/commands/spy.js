import { SlashCommandBuilder } from 'discord.js';
import { actorFromInteraction, collectionMessage, deferEphemeral, normalizeCollection, replyError } from '../utils/commandSupport.js';

export const data = new SlashCommandBuilder()
  .setName('spy').setDescription('View spy operations.')
  .addSubcommand((sub) => sub.setName('assignments').setDescription('View your spy assignments.'))
  .setDMPermission(false);
export const execute = async (interaction, context) => {
  await deferEphemeral(interaction);
  try {
    const result = await context.apiService.getMySpyAssignments(actorFromInteraction(interaction));
    await interaction.editReply(collectionMessage({
      title: 'Spy Assignments', collection: normalizeCollection(result), empty: 'No active spy assignments.',
      commandName: 'spy', userId: interaction.user.id,
    }));
  } catch (error) { await replyError(interaction, error); }
};
