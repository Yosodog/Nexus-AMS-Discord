import {
  isBoundedString,
  isDiscordSnowflake,
  toPositiveInteger,
} from '../../utils/boundaryValidators.js';
import { archiveWarCounterRoom } from '../../utils/warCounterRooms.js';
import { invalid, valid } from './support.js';

const isWarCounterSource = (source) => `${source?.type ?? ''}`.toLowerCase() === 'war_counter';

export const validate = (payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return invalid('invalid_payload');
  const source = payload.source ?? {};
  if (payload.source !== undefined && (!payload.source || typeof payload.source !== 'object' || Array.isArray(payload.source))) {
    return invalid('invalid_source');
  }
  if (isWarCounterSource(source)) {
    if (!toPositiveInteger(source.id)) return invalid('invalid_source_id');
  } else {
    if (!payload.discord_channel_id) return invalid('missing_channel');
    if (!isDiscordSnowflake(payload.discord_channel_id)) return invalid('invalid_channel');
  }
  if (payload.archive !== undefined && (!payload.archive || typeof payload.archive !== 'object' || Array.isArray(payload.archive))) {
    return invalid('invalid_archive_options');
  }
  if (payload.archive?.title_prefix !== undefined) {
    if (typeof payload.archive.title_prefix !== 'string') return invalid('invalid_title_prefix');
    if (
      payload.archive.title_prefix.trim() !== '' &&
      !isBoundedString(payload.archive.title_prefix, { minLength: 1, maxLength: 100 })
    ) return invalid('invalid_title_prefix');
  }
  return valid();
};

export const execute = async (command, runtime) => {
  const payload = command.payload;
  const source = payload.source ?? {};
  const titlePrefix =
    typeof payload?.archive?.title_prefix === 'string' && payload.archive.title_prefix !== ''
      ? payload.archive.title_prefix
      : '[Archived] ';

  let channelId = null;
  if (isWarCounterSource(source)) {
    if (!runtime.apiService?.getWarCounter) {
      return { success: false, reason: 'counter_lookup_unavailable' };
    }
    try {
      const response = await runtime.apiService.getWarCounter(source.id);
      const counter = response?.data ?? response?.counter ?? response;
      channelId = counter?.discord_channel_id ?? null;
    } catch (error) {
      runtime.logger.warn('WAR_ROOM_ARCHIVE failed to resolve persisted Nexus counter', {
        commandId: command?.id,
        sourceId: source.id,
        status: error?.response?.status ?? null,
      });
      return { success: false, reason: 'counter_lookup_failed' };
    }
  } else {
    channelId = payload.discord_channel_id.trim();
  }

  if (!isDiscordSnowflake(channelId)) {
    runtime.logger.warn('WAR_ROOM_ARCHIVE missing persisted channel id', {
      commandId: command?.id,
      sourceType: source?.type ?? null,
      sourceId: source?.id ?? null,
    });
    return { success: false, reason: channelId ? 'invalid_channel' : 'missing_channel' };
  }

  if (!runtime.canContinue()) return { success: false, reason: 'lease_lost' };
  const archiveResult = await archiveWarCounterRoom({
    client: runtime.client,
    logger: runtime.logger,
    channelId,
    guildId: runtime.guildId,
    titlePrefix,
    lock: payload?.archive?.lock !== false,
    reason: `Nexus queue ${command?.id ?? 'unknown'} WAR_ROOM_ARCHIVE`,
    logContext: {
      commandId: command?.id ?? null,
      sourceType: source?.type ?? null,
      sourceId: source?.id ?? null,
    },
  });

  return archiveResult.success ? { success: true } : { success: false, reason: archiveResult.reason };
};
