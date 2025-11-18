import { Events } from 'discord.js';

/**
 * Register the interactionCreate listener responsible for dispatching slash commands.
 * @param {import('discord.js').Client} client Discord client instance
 * @param {import('discord.js').Collection<string, any>} commands loaded command modules
 * @param {import('../services/Logger.js').Logger} logger structured logger
 * @param {object} context shared dependency container injected into commands
 */
export const registerInteractionListener = (client, commands, logger, context = {}) => {
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    const command = commands.get(interaction.commandName);

    if (!command) {
      logger.warn(`Received unknown command: ${interaction.commandName}`);
      await interaction.reply({ content: 'Command not recognized.', ephemeral: false }).catch(() => {});
      return;
    }

    try {
      await command.execute(interaction, { logger, ...context });
    } catch (error) {
      logger.error('Unhandled error executing command', error);

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({
          content: 'Something went wrong while executing that command.',
          ephemeral: false,
        }).catch(() => {});
      } else {
        await interaction
          .reply({ content: 'Something went wrong while executing that command.', ephemeral: false })
          .catch(() => {});
      }
    }
  });
};
