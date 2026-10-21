import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Report whether the module at `moduleUrl` is the script Node was asked to run.
 * Node resolves symlinks for `import.meta.url` but leaves `process.argv[1]` as given, so both
 * sides are compared as real paths; otherwise a launch through a symlinked release directory
 * (for example `/opt/nexus/nexus-discord/current/src/bot.js`) would never start.
 *
 * @param {string} moduleUrl the caller's `import.meta.url`
 * @param {string|undefined} [entryPath] the path Node was started with
 * @returns {boolean}
 */
export const isMainModule = (moduleUrl, entryPath = process.argv[1]) => {
  if (!entryPath) return false;
  try {
    return fs.realpathSync(entryPath) === fs.realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
};
