import { SlashCommandBuilder } from 'discord.js';
import { actorFromInteraction, deferEphemeral, replyError } from '../utils/commandSupport.js';
import { identityMessage } from '../utils/directoryUi.js';

export const data = new SlashCommandBuilder()
  .setName('who')
  .setDescription('View a Discord user’s minimal Nexus identity.')
  .addUserOption((option) => option
    .setName('user')
    .setDescription('Discord user to look up; defaults to you.')
    .setRequired(false))
  .setDMPermission(false);

export const help = Object.freeze({
  audience: 'Members and staff',
  topic: Object.freeze(['identity', 'directory']),
  examples: Object.freeze(['/who', '/who user:@member']),
  related: Object.freeze(['me', 'nation']),
});

export const execute = async (interaction, context) => {
  await deferEphemeral(interaction);
  try {
    const target = interaction.options.getUser('user') ?? interaction.user;
    const identity = await context.apiService.getDirectoryDiscordUser(
      actorFromInteraction(interaction, 'who'),
      target.id,
    );
    await interaction.editReply(identityMessage(identity, context.apiService.baseUrl));
  } catch (error) {
    await replyError(interaction, error, 'Identity Lookup Failed');
  }
};
