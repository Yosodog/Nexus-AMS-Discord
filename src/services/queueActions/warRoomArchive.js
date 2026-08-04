import {
  isBoundedString,
  isDiscordSnowflake,
  toPositiveInteger,
} from '../../utils/boundaryValidators.js';
import { archiveWarCounterRoom } from '../../utils/warCounterRooms.js';
import { invalid, valid } from './support.js';

const sourceType = (source) => `${source?.type ?? ''}`.trim().toLowerCase();
const isWarCounterSource = (source) => sourceType(source) === 'war_counter';
const isMilcomObjectiveSource = (source) => sourceType(source) === 'milcom_objective';
const isPersistedSource = (source) => isWarCounterSource(source) || isMilcomObjectiveSource(source);

export const validate = (payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return invalid('invalid_payload');
  const source = payload.source ?? {};
  if (payload.source !== undefined && (!payload.source || typeof payload.source !== 'object' || Array.isArray(payload.source))) {
    return invalid('invalid_source');
  }
  if (isPersistedSource(source)) {
    if (!toPositiveInteger(source.id)) return invalid('invalid_source_id');
    if (payload.discord_channel_id !== undefined && !isDiscordSnowflake(payload.discord_channel_id)) {
      return invalid('invalid_channel');
    }
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

  const fallbackChannelId = isDiscordSnowflake(payload.discord_channel_id)
    ? payload.discord_channel_id.trim()
    : null;
  let channelId = fallbackChannelId;
  if (isPersistedSource(source)) {
    const lookup = isMilcomObjectiveSource(source)
      ? runtime.apiService?.getMilcomObjective
      : runtime.apiService?.getWarCounter;
    const lookupUnavailableReason = isMilcomObjectiveSource(source)
      ? 'objective_lookup_unavailable'
      : 'counter_lookup_unavailable';
    const lookupFailedReason = isMilcomObjectiveSource(source)
      ? 'objective_lookup_failed'
      : 'counter_lookup_failed';

    if (!lookup) {
      if (!fallbackChannelId) return { success: false, reason: lookupUnavailableReason };
      runtime.logger.warn('WAR_ROOM_ARCHIVE source lookup unavailable; using direct channel fallback', {
        commandId: command?.id,
        sourceType: sourceType(source),
        sourceId: source.id,
        channelId: fallbackChannelId,
      });
    }

    try {
      if (lookup) {
        const response = await lookup.call(runtime.apiService, source.id);
        const record = resolvePersistedRoomRecord(response);
        const persistedChannelId = record?.discord_channel_id ?? null;
        if (isDiscordSnowflake(persistedChannelId)) {
          channelId = persistedChannelId.trim();
        } else if (!fallbackChannelId) {
          channelId = null;
        } else {
          runtime.logger.warn('WAR_ROOM_ARCHIVE persisted source has no usable channel; using direct fallback', {
            commandId: command?.id,
            sourceType: sourceType(source),
            sourceId: source.id,
            channelId: fallbackChannelId,
          });
        }
      }
    } catch (error) {
      runtime.logger.warn('WAR_ROOM_ARCHIVE failed to resolve persisted Nexus source', {
        commandId: command?.id,
        sourceType: sourceType(source),
        sourceId: source.id,
        status: error?.response?.status ?? null,
        fallbackChannelId,
      });
      if (!fallbackChannelId) return { success: false, reason: lookupFailedReason };
    }
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

function resolvePersistedRoomRecord(response) {
  return response?.data?.objective ??
    response?.data?.counter ??
    response?.data ??
    response?.objective ??
    response?.counter ??
    response;
}
