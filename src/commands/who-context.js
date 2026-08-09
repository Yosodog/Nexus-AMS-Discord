import { ApplicationCommandType, ContextMenuCommandBuilder } from 'discord.js';
import { actorFromInteraction, deferEphemeral, replyError } from '../utils/commandSupport.js';
import { identityMessage } from '../utils/directoryUi.js';

export const data = new ContextMenuCommandBuilder()
  .setName('View Nexus identity')
  .setType(ApplicationCommandType.User)
  .setDMPermission(false);

export const connectionCommandName = 'who';

export const execute = async (interaction, context) => {
  await deferEphemeral(interaction);
  try {
    const identity = await context.apiService.getDirectoryDiscordUser(
      actorFromInteraction(interaction, 'who'),
      interaction.targetUser.id,
    );
    await interaction.editReply(identityMessage(identity, context.apiService.baseUrl));
  } catch (error) {
    await replyError(interaction, error, 'Identity Lookup Failed');
  }
};
