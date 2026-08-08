import { SlashCommandBuilder } from 'discord.js';
import { statusMessage } from '../utils/discordUi.js';

/**
 * /ping command used solely to confirm the bot wiring is functional.
 * Replies ephemerally with a simple latency confirmation.
 */
export const data = new SlashCommandBuilder()
  .setName('ping')
  .setDescription('Check whether the bot is alive and responding.')
  .setDMPermission(false);

export const help = Object.freeze({
  audience: 'Everyone',
  topic: Object.freeze(['getting-started']),
  examples: Object.freeze(['/ping']),
  related: Object.freeze(['help', 'verify']),
});

/**
 * Execute handler for /ping.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction incoming command interaction
 * @param {{ logger: import('../services/Logger.js').Logger }} context dependency container with shared utilities
 */
export const execute = async (interaction, { logger }) => {
  try {
    await interaction.reply({
      ...statusMessage({
        title: 'Online',
        tone: 'success',
        description: 'The Discord bot is online and responding.',
      }),
      ephemeral: true,
    });
  } catch (error) {
    logger.error('Failed to respond to /ping command', {
      errorMessage: error?.message ?? String(error),
    });
    // Best-effort follow-up so the user is not left hanging; ignore errors because Discord may block duplicates.
    if (!interaction.replied) {
      await interaction.reply({
        ...statusMessage({
          title: 'Ping Failed',
          tone: 'danger',
          description: 'The bot could not complete the status check.',
        }),
        ephemeral: true,
      }).catch(() => {});
    }
  }
};
