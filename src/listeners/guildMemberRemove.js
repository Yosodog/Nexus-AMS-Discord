import { Events } from 'discord.js';
import { isDiscordSnowflake } from '../utils/boundaryValidators.js';

export const registerGuildMemberRemoveListener = (
  client,
  logger,
  { connectionResolver, applicationId, connectionServiceFactory },
) => {
  client.on(Events.GuildMemberRemove, async (member) => {
    if (!isDiscordSnowflake(member.id)) return;

    let connection;
    try {
      connection = connectionResolver.resolve({ applicationId, guildId: member.guild?.id });
    } catch {
      return;
    }

    try {
      const apiService = connection.apiService ?? connectionServiceFactory(connection);
      if (!apiService) throw new Error('Nexus connection service unavailable');
      await apiService.reportApplicationMemberDeparture(member.id);
    } catch (error) {
      logger.warn('Failed to report Discord member departure to Nexus', {
        guildId: connection.guildId,
        discordUserId: member.id,
        status: error?.response?.status ?? null,
        errorCode: error?.code ?? null,
      });
    }
  });
};
