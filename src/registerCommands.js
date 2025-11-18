import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { loadCommands } from './commands/index.js';
import { Logger } from './services/Logger.js';
import { config } from './utils/config.js';
import { validateEnv } from './utils/validateEnv.js';

const logger = new Logger('RegisterCommands');

const requiredEnv = ['DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID'];
validateEnv(requiredEnv, logger);

const rest = new REST({ version: '10' }).setToken(config.discord.token);

const register = async () => {
  const { commandData } = await loadCommands(logger);

  try {
    logger.info(`Registering ${commandData.length} slash command(s) for guild deployment...`);
    await rest.put(
      Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId),
      { body: commandData },
    );
    logger.info('Successfully registered guild commands.');
  } catch (error) {
    logger.error('Failed to register commands', error);
  }
};

register().catch((error) => {
  logger.error('Fatal command registration error', error);
  process.exit(1);
});
