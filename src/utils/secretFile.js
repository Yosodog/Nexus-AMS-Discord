import fs from 'node:fs';

/**
 * Resolve a secret from a root-owned credential file when the corresponding
 * *_FILE setting is present. A configured file is authoritative so a failed
 * read cannot silently fall back to a stale environment value.
 *
 * @param {string} environmentKey
 * @param {NodeJS.ProcessEnv} [environment]
 * @returns {string|undefined}
 */
export const readSecret = (environmentKey, environment = process.env) => {
  const fileKey = `${environmentKey}_FILE`;
  const filePath = environment[fileKey];

  if (typeof filePath === 'string' && filePath.trim() !== '') {
    try {
      const value = fs.readFileSync(filePath, 'utf8').trim();
      return value || undefined;
    } catch {
      // Keep startup errors generic so neither paths nor secret values leak.
      return undefined;
    }
  }

  const value = environment[environmentKey];
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined;
};
