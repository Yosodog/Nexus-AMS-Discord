import { readdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { Collection } from 'discord.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const retiredCommandFiles = new Set(['archivecounter.js']);

/**
 * Dynamically load all command modules from the commands directory.
 * This allows new commands to be added without modifying the loader.
 * @param {import('../services/Logger.js').Logger} logger structured logger instance
 * @returns {Promise<{ commands: import('discord.js').Collection<string, any>, commandData: any[] }>}
 */
export const loadCommands = async (logger, { directory = __dirname, importer = (url) => import(url) } = {}) => {
  const commands = new Collection();
  const commandData = [];
  const errors = [];

  const entries = (await readdir(directory)).sort();

  for (const file of entries) {
    if (!file.endsWith('.js') || file === 'index.js') {
      continue;
    }

    if (retiredCommandFiles.has(file)) {
      logger.debug('Skipped retired command module', file);
      continue;
    }

    const filePath = path.join(directory, file);

    try {
      const commandModule = await importer(pathToFileURL(filePath).href);

      if (!commandModule?.data || typeof commandModule?.execute !== 'function') {
        errors.push(new Error(`${file} must export command data and an execute function.`));
        continue;
      }

      if (typeof commandModule.data.toJSON !== 'function') {
        errors.push(new Error(`${file} command data must provide toJSON().`));
        continue;
      }

      let serialized;
      try {
        serialized = commandModule.data.toJSON();
        JSON.stringify(serialized);
      } catch (error) {
        errors.push(new Error(`${file} command data could not be serialized.`, { cause: error }));
        continue;
      }

      const commandName = serialized?.name;
      if (typeof commandName !== 'string' || commandName.trim() === '') {
        errors.push(new Error(`${file} command data is missing a valid name.`));
        continue;
      }

      if (commands.has(commandName)) {
        errors.push(new Error(`${file} duplicates the command name "${commandName}".`));
        continue;
      }

      commands.set(commandName, commandModule);
      commandData.push(serialized);
      logger.debug(`Loaded command module`, commandName);
    } catch (error) {
      errors.push(new Error(`Failed to load command file ${file}.`, { cause: error }));
    }
  }

  if (errors.length > 0) {
    for (const error of errors) {
      logger.error('Command validation failed', { message: error.message, cause: error.cause?.message ?? null });
    }
    throw new AggregateError(errors, `Unable to load ${errors.length} command module(s).`);
  }

  // Summarize loaded commands for easier debugging/registration confirmation.
  logger.info(`Loaded ${commands.size} command(s): ${Array.from(commands.keys()).join(', ')}`);

  return { commands, commandData };
};
