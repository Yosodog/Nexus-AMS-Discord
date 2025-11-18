import { SlashCommandBuilder } from 'discord.js';

/**
 * /ping command used solely to confirm the bot wiring is functional.
 * Replies publicly in the channel with a simple latency confirmation.
 */
export const data = new SlashCommandBuilder()
  .setName('ping')
  .setDescription('Check whether the bot is alive and responding.');

/**
 * Execute handler for /ping.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction incoming command interaction
 * @param {{ logger: import('../services/Logger.js').Logger }} context dependency container with shared utilities
 */
export const execute = async (interaction, { logger }) => {
  try {
    await interaction.reply({
      content: 'Pong! The bot is online and reachable.',
      ephemeral: false,
    });
  } catch (error) {
    logger.error('Failed to respond to /ping command', error);
    // Best-effort follow-up so the user is not left hanging; ignore errors because Discord may block duplicates.
    if (!interaction.replied) {
      await interaction.reply({ content: 'Something went wrong handling /ping.', ephemeral: false }).catch(() => {});
    }
  }
};
