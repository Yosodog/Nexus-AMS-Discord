import { readdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { Collection } from 'discord.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Dynamically load all command modules from the commands directory.
 * This allows new commands to be added without modifying the loader.
 * @param {import('../services/Logger.js').Logger} logger structured logger instance
 * @returns {Promise<{ commands: import('discord.js').Collection<string, any>, commandData: any[] }>}
 */
export const loadCommands = async (logger) => {
  const commands = new Collection();
  const commandData = [];

  const entries = await readdir(__dirname);

  for (const file of entries) {
    if (!file.endsWith('.js') || file === 'index.js') {
      continue;
    }

    const filePath = path.join(__dirname, file);

    try {
      const commandModule = await import(pathToFileURL(filePath).href);

      if (!commandModule?.data || !commandModule?.execute) {
        logger.warn(`Skipping command ${file} because it does not export both data and execute.`);
        continue;
      }

      const commandName = commandModule.data.name;
      commands.set(commandName, commandModule);
      commandData.push(commandModule.data.toJSON());
      logger.debug(`Loaded command module`, commandName);
    } catch (error) {
      logger.error(`Failed to load command file ${file}`, error);
    }
  }

  // Summarize loaded commands for easier debugging/registration confirmation.
  logger.info(`Loaded ${commands.size} command(s): ${Array.from(commands.keys()).join(', ')}`);

  return { commands, commandData };
};
