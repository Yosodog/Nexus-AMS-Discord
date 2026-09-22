import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readSecret } from '../src/utils/secretFile.js';

test('credential file takes precedence over an environment secret and trims one trailing newline', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-discord-secret-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'token');
  await fs.writeFile(file, 'file-secret\n', { mode: 0o600 });

  assert.equal(readSecret('DISCORD_BOT_TOKEN', {
    DISCORD_BOT_TOKEN: 'environment-secret',
    DISCORD_BOT_TOKEN_FILE: file,
  }), 'file-secret');
});

test('configured but unreadable credential file fails closed instead of falling back', () => {
  assert.equal(readSecret('NEXUS_API_KEY', {
    NEXUS_API_KEY: 'environment-secret',
    NEXUS_API_KEY_FILE: '/path/that/does/not/exist',
  }), undefined);
});
