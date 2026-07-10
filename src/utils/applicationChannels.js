import { ChannelType } from 'discord.js';
import { isDiscordSnowflake, toPositiveInteger } from './boundaryValidators.js';

export const APPLICATION_TOPIC_REGEX = /^nexus-application:(\d+);nation:(\d+)$/;
export const LEGACY_APPLICATION_CHANNEL_REGEX = /^app-(\d+)-(\d+)-[a-z0-9]+(?:-[a-z0-9]+)*$/i;

export const buildApplicationChannelTopic = (applicationId, nationId) => {
  const normalizedApplicationId = toPositiveInteger(applicationId);
  const normalizedNationId = toPositiveInteger(nationId);

  if (!normalizedApplicationId || !normalizedNationId) {
    return null;
  }

  return `nexus-application:${normalizedApplicationId};nation:${normalizedNationId}`;
};

export const resolveApplicationIdentity = (application, nation = null) => {
  const applicationId = toPositiveInteger(
    application?.id ?? application?.application_id ?? application?.nexus_id,
  );
  const nationId = toPositiveInteger(
    nation?.id ??
      nation?.nation_id ??
      application?.nation_id ??
      application?.nation?.id ??
      application?.nation?.nation_id,
  );

  return applicationId && nationId ? { applicationId, nationId } : null;
};

export const parseApplicationChannelIdentity = (channel) => {
  if (!channel || typeof channel !== 'object') {
    return null;
  }

  const topic = typeof channel.topic === 'string' ? channel.topic.trim() : '';
  if (topic) {
    const match = APPLICATION_TOPIC_REGEX.exec(topic);
    if (!match) {
      return null;
    }

    return {
      applicationId: Number(match[1]),
      nationId: Number(match[2]),
      source: 'topic',
    };
  }

  const name = typeof channel.name === 'string' ? channel.name : '';
  const match = LEGACY_APPLICATION_CHANNEL_REGEX.exec(name);
  if (!match) {
    return null;
  }

  return {
    applicationId: Number(match[1]),
    nationId: Number(match[2]),
    source: 'legacy_name',
  };
};

export const isGuildTextChannel = (channel) => channel?.type === ChannelType.GuildText;

export const validateApplicationInterviewChannel = ({ channel, application, nation = null, guildId }) => {
  if (!channel) {
    return { valid: false, reason: 'channel_unavailable' };
  }

  const normalizedGuildId = typeof guildId === 'string' ? guildId.trim() : '';
  const channelGuildId = `${channel.guildId ?? channel.guild?.id ?? ''}`.trim();
  if (!normalizedGuildId || channelGuildId !== normalizedGuildId) {
    return { valid: false, reason: 'wrong_guild' };
  }

  if (!isGuildTextChannel(channel)) {
    return { valid: false, reason: 'wrong_channel_type' };
  }

  const expected = resolveApplicationIdentity(application, nation);
  if (!expected) {
    return { valid: false, reason: 'missing_application_identity' };
  }

  const actual = parseApplicationChannelIdentity(channel);
  if (!actual || actual.applicationId !== expected.applicationId || actual.nationId !== expected.nationId) {
    return { valid: false, reason: 'application_mismatch' };
  }

  return { valid: true, identitySource: actual.source };
};

/**
 * Delete only the authoritative channel stored on the Nexus application.
 * No cache-wide or current-channel inference is permitted.
 */
export const cleanupApplicationInterviewChannel = async ({
  guild,
  guildId,
  application,
  logger,
  reason,
}) => {
  const normalizedGuildId = typeof guildId === 'string' ? guildId.trim() : '';
  if (!normalizedGuildId || `${guild?.id ?? ''}` !== normalizedGuildId) {
    return { success: false, reason: 'wrong_guild' };
  }

  const rawChannelId = application?.discord_channel_id;
  const channelId = typeof rawChannelId === 'string' ? rawChannelId.trim() : '';
  if (rawChannelId === undefined || rawChannelId === null || rawChannelId === '') {
    return { success: false, reason: 'missing_channel' };
  }

  if (!isDiscordSnowflake(channelId)) {
    return { success: false, reason: 'invalid_channel_id' };
  }

  let channel;
  try {
    channel = await guild.channels.fetch(channelId);
  } catch (error) {
    logger?.warn?.('Unable to fetch authoritative application channel', {
      channelId,
      errorMessage: error?.message ?? String(error),
    });
    return { success: false, reason: 'channel_unavailable', channelId };
  }

  const validation = validateApplicationInterviewChannel({
    channel,
    application,
    guildId: normalizedGuildId,
  });
  if (!validation.valid) {
    logger?.warn?.('Refusing to delete unverified application channel', {
      channelId,
      reason: validation.reason,
    });
    return { success: false, reason: validation.reason, channelId };
  }

  try {
    await channel.delete(reason);
    return { success: true, channelId, identitySource: validation.identitySource };
  } catch (error) {
    logger?.warn?.('Failed to delete verified application channel', {
      channelId,
      errorMessage: error?.message ?? String(error),
    });
    return { success: false, reason: 'discord_delete_failed', channelId };
  }
};
