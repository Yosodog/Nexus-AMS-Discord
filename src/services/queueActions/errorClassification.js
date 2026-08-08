const RETRYABLE_CLASSIFICATIONS = new Set([
  'rate_limited',
  'discord_unavailable',
  'network_error',
]);

const NETWORK_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'ERR_NETWORK',
  'UND_ERR_CONNECT_TIMEOUT',
]);

const numericCode = (error) => {
  const candidates = [
    error?.code,
    error?.rawError?.code,
    error?.data?.code,
    error?.response?.data?.code,
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isInteger(value)) return value;
  }
  return null;
};

const stringCode = (error) => {
  const candidate = error?.code ?? error?.response?.data?.code ?? null;
  return typeof candidate === 'string' ? candidate.toUpperCase() : null;
};

const responseStatus = (error) => Number(error?.status ?? error?.response?.status ?? NaN);

export const retryAfterMs = (error) => {
  const candidates = [
    error?.retry_after,
    error?.rawError?.retry_after,
    error?.data?.retry_after,
    error?.response?.data?.retry_after,
    error?.response?.headers?.['retry-after'],
    error?.response?.headers?.get?.('retry-after'),
  ];

  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === '') continue;
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric >= 0) {
      return Math.max(0, Math.ceil(numeric * 1000));
    }

    const date = Date.parse(`${candidate}`);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }

  return null;
};

export const isRetryableAlertClassification = (classification) =>
  RETRYABLE_CLASSIFICATIONS.has(classification);

export const classifyDiscordError = (error, { fallback = 'discord_unavailable' } = {}) => {
  const code = numericCode(error);
  const symbolicCode = stringCode(error);
  const status = responseStatus(error);

  if (status === 429 || code === 429 || retryAfterMs(error) !== null) return 'rate_limited';
  if (code === 50007) return 'dm_closed';
  if (code === 10013) return 'unknown_user';
  if (code === 10003) return 'channel_not_found';
  if (code === 50013 || code === 50001) return 'missing_permissions';
  if (code === 10004) return 'foreign_guild';
  if (symbolicCode && NETWORK_ERROR_CODES.has(symbolicCode)) return 'network_error';
  if (error?.request && !error?.response) return 'network_error';
  if ([408, 425, 500, 502, 503, 504].includes(status)) return 'discord_unavailable';

  return fallback;
};

export const alertErrorReceipt = (error, {
  deliveryId,
  guildId = null,
  channelId = null,
  fallback = 'discord_unavailable',
} = {}) => {
  const classification = classifyDiscordError(error, { fallback });
  const receipt = {
    success: false,
    delivery_id: deliveryId,
    classification,
    guild_id: guildId,
    channel_id: channelId,
    message_id: null,
    error_code: classification,
    retryable: isRetryableAlertClassification(classification),
  };
  const retryAfter = retryAfterMs(error);
  if (retryAfter !== null) receipt.retry_after_ms = retryAfter;
  return receipt;
};

export const ALERT_ERROR_CLASSIFICATIONS = Object.freeze([
  'recipient_unavailable',
  'dm_closed',
  'unknown_user',
  'channel_not_found',
  'missing_permissions',
  'foreign_guild',
  'rate_limited',
  'discord_unavailable',
  'network_error',
  'invalid_payload',
]);
