import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
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
  audience: 'Nexus diagnostic staff and Discord server managers',
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
  const provider = status?.provider ?? null;
  return [
    `Gateway: **${gateway.ready ? 'ready' : 'not ready'}** (status ${value(gateway.status)})`,
    `Route mode: **${value(routing.mode)}** · connection: **${value(routing.state, 'unconfigured')}**`,
    `Guild diagnostics: **${discord.observed ? 'observed' : 'not observed'}**`,
    `Bot permissions: ${permissions.length > 0 ? permissions.join(', ') : 'none observed'}`,
    ...(provider ? [
      `Nexus provider: **${provider.available ? 'available' : 'unavailable'}**${provider.version ? ` · ${provider.version}` : ''}`,
    ] : []),
  ].join('\n');
};

const renderSetupStatus = (status) => {
  const gateway = status?.gateway ?? {};
  const routing = status?.routing ?? {};
  const discord = status?.discord ?? {};
  const permissions = discord.permissions?.granted ?? [];
  return [
    'Nexus is not connected to this Discord server. Limited setup diagnostics:',
    `Gateway: **${gateway.ready ? 'ready' : 'not ready'}** (status ${value(gateway.status)})`,
    `Route mode: **${value(routing.mode)}**`,
    `Guild diagnostics: **${discord.observed ? 'observed' : 'not observed'}**`,
    `Bot permissions: ${permissions.length > 0 ? permissions.join(', ') : 'none observed'}`,
  ].join('\n');
};

const hasSetupPermission = (interaction) => {
  const permissions = interaction?.memberPermissions ?? interaction?.member?.permissions;
  return permissions?.has?.(PermissionFlagsBits.Administrator) === true
    || permissions?.has?.(PermissionFlagsBits.ManageGuild) === true;
};

const providerDiagnostics = (response) => {
  const data = response?.data ?? response;
  const provider = data?.provider ?? data?.diagnostics?.provider ?? null;
  if (provider?.authorization_authority !== 'nexus') return null;
  return {
    available: provider.status !== 'unavailable',
    version: typeof provider.version === 'string' ? provider.version.slice(0, 64) : null,
  };
};

export const execute = async (interaction, { statusService, apiService, logger } = {}) => {
  if (interaction.options?.getSubcommand?.() !== 'status') {
    await interaction.reply({
      ...statusMessage({ title: 'Nexus', tone: 'warning', description: 'Use `/nexus status`.' }),
      ephemeral: true,
    });
    return;
  }
  const status = statusService?.getStatus?.({ guildId: interaction.guildId });
  if (!status) {
    await interaction.reply({
      ...statusMessage({
        title: 'Nexus Status',
        tone: 'warning',
        description: 'Nexus diagnostics are unavailable. No local routing details were shown.',
      }),
      ephemeral: true,
    });
    return;
  }

  if (status.routing?.connected !== true) {
    if (!hasSetupPermission(interaction)) {
      await interaction.reply({
        ...statusMessage({
          title: 'Nexus Setup Status',
          tone: 'warning',
          description: 'Limited setup diagnostics require Discord Administrator or Manage Server permission.',
        }),
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      ...statusMessage({ title: 'Nexus Setup Status', tone: 'info', description: renderSetupStatus(status) }),
      ephemeral: true,
    });
    return;
  }

  try {
    if (typeof apiService?.getNexusStatus !== 'function') throw new Error('Nexus status provider is unavailable.');
    const providerResponse = await apiService.getNexusStatus(actorFromInteraction(interaction));
    const provider = providerDiagnostics(providerResponse);
    if (!provider) throw new Error('Nexus status provider returned an invalid authorization result.');
    status.provider = provider;
  } catch (error) {
    logger?.debug?.('Nexus provider status denied or unavailable', {
      errorCode: error?.response?.data?.error?.code ?? error?.code ?? 'STATUS_UNAVAILABLE',
    });
    await interaction.reply({
      ...statusMessage({
        title: 'Nexus Status',
        tone: 'warning',
        description: 'Nexus did not authorize diagnostic access or is unavailable. No local routing details were shown.',
      }),
      ephemeral: true,
    });
    return;
  }
  await interaction.reply({
    ...statusMessage({ title: 'Nexus Status', tone: 'info', description: renderStatus(status) }),
    ephemeral: true,
  });
};

export { renderStatus };
