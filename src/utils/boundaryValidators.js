const DISCORD_SNOWFLAKE_PATTERN = /^\d{17,20}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Discord identifiers are unsigned decimal snowflakes. Keeping this check at
 * external boundaries prevents arbitrary queue/API values from becoming
 * channel, role, or user targets.
 */
export const isDiscordSnowflake = (value) => {
  if (typeof value !== 'string') {
    return false;
  }
  const normalized = value.trim();
  return DISCORD_SNOWFLAKE_PATTERN.test(normalized) && normalized !== '0'.repeat(normalized.length);
};

/** Validate a canonical UUID supplied by Nexus queue/idempotency boundaries. */
export const isUuid = (value) =>
  typeof value === 'string' && UUID_PATTERN.test(value.trim());

/** Normalize a positive integer identifier, returning null for invalid input. */
export const toPositiveInteger = (value) => {
  const normalized = typeof value === 'string' && /^\d+$/.test(value.trim())
    ? Number(value.trim())
    : value;

  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : null;
};

/** Accept only absolute HTTP(S) URLs; production callers can require HTTPS. */
export const isHttpUrl = (value, { httpsOnly = false } = {}) => {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    const url = new URL(value.trim());
    return httpsOnly ? url.protocol === 'https:' : ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
};

/** Normalize a bounded string, returning null for the wrong type or length. */
export const normalizeBoundedString = (
  value,
  { minLength = 0, maxLength = Number.MAX_SAFE_INTEGER, trim = true } = {},
) => {
  if (typeof value !== 'string') return null;
  const normalized = trim ? value.trim() : value;
  return normalized.length >= minLength && normalized.length <= maxLength ? normalized : null;
};

export const isBoundedString = (value, options) => normalizeBoundedString(value, options) !== null;
