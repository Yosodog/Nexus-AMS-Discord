import { ApplicationCommandType, ContextMenuCommandBuilder } from 'discord.js';
import { deferEphemeral, replyError } from '../utils/commandSupport.js';
import { applicationReviewForDiscordContext } from './applications.js';

export const data = new ContextMenuCommandBuilder()
  .setName('Review Nexus application')
  .setType(ApplicationCommandType.User)
  .setDMPermission(false);

export const connectionCommandName = 'applications';

export const execute = async (interaction, context) => {
  await deferEphemeral(interaction);
  try {
    const message = await applicationReviewForDiscordContext(interaction, context, {
      applicantDiscordId: interaction.targetUser.id,
    });
    await interaction.editReply(message);
  } catch (error) {
    await replyError(interaction, error, 'Application Review Failed');
  }
};
