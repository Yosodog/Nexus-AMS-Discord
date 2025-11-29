/**
 * Convert a string into a Discord-safe slug suitable for channel names.
 * Lowercases, removes special characters, replaces whitespace with hyphens,
 * and limits the length to keep channel names compact.
 * @param {string} value raw input string to slugify
 * @param {number} [maxLength=20] maximum length of the resulting slug
 * @returns {string} slugified value safe for Discord channel names
 */
export const slugify = (value, maxLength = 20) => {
  if (!value || typeof value !== 'string') {
    return 'applicant';
  }

  const normalized = value
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase();

  const truncated = normalized.slice(0, maxLength).replace(/^-+|-+$/g, '');

  return truncated || 'applicant';
};
