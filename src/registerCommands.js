import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { REST, Routes } from 'discord.js';
import { loadCommands } from './commands/index.js';
import { Logger } from './services/Logger.js';
import { isOfficialSharedMode } from './services/connection/ConnectionContext.js';
import { config } from './utils/config.js';
import { validateEnv } from './utils/validateEnv.js';

export const registerCommands = async ({
  rest,
  logger,
  clientId,
  guildId,
  deploymentMode = 'dedicated',
  commandLoader = loadCommands,
}) => {
  // Loading and validating the complete command set must finish before the first REST mutation.
  const { commandData } = await commandLoader(logger);
  const shared = isOfficialSharedMode(deploymentMode);
  logger.info(`Registering ${commandData.length} application command(s) for ${shared ? 'global' : 'guild'} deployment...`);
  await rest.put(
    shared ? Routes.applicationCommands(clientId) : Routes.applicationGuildCommands(clientId, guildId),
    { body: commandData },
  );
  logger.info(`Successfully registered ${shared ? 'global' : 'guild'} commands.`);
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const logger = new Logger('RegisterCommands');
  const requiredEnv = ['DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_ID'];
  if (config.discord.deploymentMode === 'dedicated') requiredEnv.push('DISCORD_GUILD_ID');
  validateEnv(requiredEnv, logger);
  const rest = new REST({ version: '10' }).setToken(config.discord.token);

  registerCommands({
    rest,
    logger,
    clientId: config.discord.clientId,
    guildId: config.discord.guildId,
    deploymentMode: config.discord.deploymentMode,
  }).catch((error) => {
    logger.error('Fatal command registration error', error);
    process.exit(1);
  });
}
