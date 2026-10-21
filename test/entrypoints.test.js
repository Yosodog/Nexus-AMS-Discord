import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainModule } from '../src/utils/isMainModule.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Mirror the updater layout: /opt/nexus/nexus-discord/current -> releases/vX.Y.Z.
const createReleaseLayout = async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-discord-entry-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const current = path.join(directory, 'current');
  await fs.symlink(repositoryRoot, current, 'dir');
  return { directory, current };
};

const runEntryPoint = (entryPath, { cwd, env = {} }) => spawnSync(process.execPath, [entryPath], {
  cwd,
  encoding: 'utf8',
  env: { PATH: process.env.PATH, ...env },
  timeout: 15_000,
});

test('isMainModule matches the entry path directly and through a symlink', async (t) => {
  const { current } = await createReleaseLayout(t);
  const moduleUrl = pathToFileURL(path.join(repositoryRoot, 'src/bot.js')).href;

  assert.equal(isMainModule(moduleUrl, path.join(repositoryRoot, 'src/bot.js')), true);
  assert.equal(isMainModule(moduleUrl, path.join(current, 'src/bot.js')), true);
  assert.equal(isMainModule(moduleUrl, path.join(current, 'src/healthcheck.js')), false);
  assert.equal(isMainModule(moduleUrl, path.join(current, 'src/missing.js')), false);
  assert.equal(isMainModule(moduleUrl, undefined), false);
});

test('an entry-point module started through a symlinked release directory counts as main', async (t) => {
  const { directory } = await createReleaseLayout(t);
  const release = path.join(directory, 'releases', 'v1.0.0');
  await fs.mkdir(release, { recursive: true });
  await fs.writeFile(path.join(release, 'entry.js'), [
    `import { isMainModule } from ${JSON.stringify(pathToFileURL(path.join(repositoryRoot, 'src/utils/isMainModule.js')).href)};`,
    "process.stdout.write(isMainModule(import.meta.url) ? 'main' : 'imported');",
    '',
  ].join('\n'));
  await fs.symlink(release, path.join(directory, 'live'), 'dir');

  const result = runEntryPoint(path.join(directory, 'live', 'entry.js'), { cwd: directory });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'main');
});

test('healthcheck runs when started through a symlinked release directory', async (t) => {
  const { directory, current } = await createReleaseLayout(t);

  const result = runEntryPoint(path.join(current, 'src/healthcheck.js'), {
    cwd: directory,
    env: { PROCESS_HEALTH_FILE: path.join(directory, 'missing-health.json') },
  });

  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'unhealthy: unavailable\n');
});

test('command registration accepts DISCORD_BOT_TOKEN_FILE without DISCORD_BOT_TOKEN', async (t) => {
  const { directory, current } = await createReleaseLayout(t);
  const tokenFile = path.join(directory, 'discord-bot-token');
  await fs.writeFile(tokenFile, 'file-token\n', { mode: 0o600 });

  // An invalid client ID stops the script at validation, before any Discord request.
  const result = runEntryPoint(path.join(current, 'src/registerCommands.js'), {
    cwd: directory,
    env: {
      DISCORD_BOT_TOKEN_FILE: tokenFile,
      DISCORD_CLIENT_ID: 'not-a-snowflake',
      DISCORD_GUILD_ID: '123456789012345678',
    },
  });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1, output);
  assert.match(output, /DISCORD_CLIENT_ID must be a Discord snowflake/);
  assert.doesNotMatch(output, /Missing required environment variables/);
});

test('command registration still reports a missing bot token', async (t) => {
  const { directory, current } = await createReleaseLayout(t);

  const result = runEntryPoint(path.join(current, 'src/registerCommands.js'), {
    cwd: directory,
    env: {
      DISCORD_CLIENT_ID: '123456789012345678',
      DISCORD_GUILD_ID: '123456789012345678',
    },
  });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1, output);
  assert.match(output, /Missing required environment variables: DISCORD_BOT_TOKEN\b/);
});
