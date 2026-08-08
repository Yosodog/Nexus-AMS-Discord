import { SlashCommandBuilder } from 'discord.js';
import { actorFromInteraction } from '../utils/commandSupport.js';
import { statusMessage } from '../utils/discordUi.js';

export const data = new SlashCommandBuilder()
  .setName('nexus')
  .setDescription('Inspect the bot connection to Nexus.')
  .addSubcommand((subcommand) => subcommand
    .setName('status')
    .setDescription('Show safe Discord, gateway, and Nexus route diagnostics.'))
  .setDMPermission(false);

export const help = Object.freeze({
  audience: 'Everyone',
  topic: Object.freeze(['getting-started']),
  examples: Object.freeze(['/nexus status']),
  related: Object.freeze(['ping', 'help']),
});

const value = (entry, fallback = 'unknown') => (
  entry === undefined || entry === null || entry === '' ? fallback : `${entry}`
);

const renderStatus = (status) => {
  const gateway = status?.gateway ?? {};
  const routing = status?.routing ?? {};
  const discord = status?.discord ?? {};
  const permissions = discord.permissions?.granted ?? [];
  const connectionLines = (routing.connections ?? []).slice(0, 12).map((connection) => (
    `${connection.guild_id}: ${connection.state}${connection.stale ? ' (stale)' : ''} · gen ${connection.generation}`
  ));
  const provider = status?.provider ?? null;
  return [
    `Gateway: **${gateway.ready ? 'ready' : 'not ready'}** (status ${value(gateway.status)})`,
    `Observed guilds: **${value(gateway.guild_count, '0')}**`,
    `Route mode: **${value(routing.mode)}** · active connections: **${value(routing.active_connections, '0')}**`,
    `Guild diagnostics: **${discord.observed ? 'observed' : 'not observed'}**`,
    `Bot permissions: ${permissions.length > 0 ? permissions.join(', ') : 'none observed'}`,
    ...(provider ? [
      `Nexus provider: **${provider.available ? 'available' : 'unavailable'}**${provider.version ? ` · ${provider.version}` : ''}`,
    ] : []),
    ...(connectionLines.length > 0 ? ['Connections:', ...connectionLines] : []),
  ].join('\n');
};

export const execute = async (interaction, { statusService, apiService, logger } = {}) => {
  if (interaction.options?.getSubcommand?.() !== 'status') {
    await interaction.reply({
      ...statusMessage({ title: 'Nexus', tone: 'warning', description: 'Use `/nexus status`.' }),
      ephemeral: true,
    });
    return;
  }
  const status = statusService?.getStatus?.({ guildId: interaction.guildId }) ?? {
    gateway: { ready: false },
    routing: { mode: 'unconfigured', active_connections: 0 },
  };
  if (apiService?.getNexusStatus) {
    try {
      const providerResponse = await apiService.getNexusStatus(actorFromInteraction(interaction));
      const provider = providerResponse?.provider ?? providerResponse?.diagnostics ?? providerResponse;
      status.provider = {
        available: true,
        version: typeof provider?.version === 'string' ? provider.version.slice(0, 64) : null,
      };
    } catch (error) {
      logger?.debug?.('Nexus provider status unavailable', { errorCode: error?.code ?? 'STATUS_UNAVAILABLE' });
      status.provider = { available: false };
    }
  }
  await interaction.reply({
    ...statusMessage({ title: 'Nexus Status', tone: 'info', description: renderStatus(status) }),
    ephemeral: true,
  });
};

export { renderStatus };
