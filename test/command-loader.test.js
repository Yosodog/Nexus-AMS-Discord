import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadCommands } from '../src/commands/index.js';
import { registerCommands } from '../src/registerCommands.js';
import { createLogger } from './helpers.js';

async function withCommandDirectory(files, callback) {
  const directory = await mkdtemp(path.join(tmpdir(), 'nexus-command-test-'));
  try {
    await Promise.all(files.map((file) => writeFile(path.join(directory, file), '// test fixture\n')));
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const command = (name) => ({
  data: { name, toJSON: () => ({ name, description: `${name} command` }) },
  execute: async () => {},
});

test('loadCommands returns a complete validated command collection', async () => {
  await withCommandDirectory(['alpha.js', 'beta.js', 'ignore.txt'], async (directory) => {
    const modules = { 'alpha.js': command('alpha'), 'beta.js': command('beta') };
    const { commands, commandData } = await loadCommands(createLogger(), {
      directory,
      importer: async (url) => modules[path.basename(new URL(url).pathname)],
    });

    assert.deepEqual(Array.from(commands.keys()), ['alpha', 'beta']);
    assert.deepEqual(commandData.map(({ name }) => name), ['alpha', 'beta']);
  });
});

test('loadCommands fails atomically on duplicate, malformed, and import errors', async () => {
  await withCommandDirectory(['duplicate-a.js', 'duplicate-b.js', 'malformed.js', 'throws.js'], async (directory) => {
    const importer = async (url) => {
      const file = path.basename(new URL(url).pathname);
      if (file === 'throws.js') throw new Error('broken import');
      if (file === 'malformed.js') return { data: { name: 'bad' } };
      return command('duplicate');
    };

    await assert.rejects(
      () => loadCommands(createLogger(), { directory, importer }),
      (error) => error instanceof AggregateError && error.errors.length === 3,
    );
  });
});

test('registerCommands performs no Discord PUT when command loading fails', async () => {
  let puts = 0;
  const loadError = new AggregateError([new Error('invalid command')], 'invalid commands');

  await assert.rejects(
    () => registerCommands({
      rest: { put: async () => { puts += 1; } },
      logger: createLogger(),
      clientId: '123456789012345678',
      guildId: '223456789012345678',
      commandLoader: async () => { throw loadError; },
    }),
    loadError,
  );

  assert.equal(puts, 0);
});

test('registerCommands publishes the complete serialized command set in one PUT', async () => {
  const calls = [];
  await registerCommands({
    rest: { put: async (...args) => calls.push(args) },
    logger: createLogger(),
    clientId: '123456789012345678',
    guildId: '223456789012345678',
    commandLoader: async () => ({ commandData: [{ name: 'alpha' }, { name: 'beta' }] }),
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], { body: [{ name: 'alpha' }, { name: 'beta' }] });
});
