import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { execFileSync } from 'node:child_process';

test('relay key generator emits the exact relay-v2 environment contract', () => {
  const output = execFileSync(process.execPath, ['src/generateRelayKey.js'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  const environment = Object.fromEntries(
    output.trim().split('\n').map((line) => line.split(/=(.*)/s).slice(0, 2)),
  );

  assert.deepEqual(Object.keys(environment), [
    'NEXUS_DISCORD_RELAY_PRIVATE_KEY',
    'DISCORD_RELAY_CURRENT_PUBLIC_KEY',
  ]);
  assert.match(environment.DISCORD_RELAY_CURRENT_PUBLIC_KEY, /^[A-Za-z0-9_-]{43}$/);

  const privateKey = createPrivateKey({
    key: Buffer.from(environment.NEXUS_DISCORD_RELAY_PRIVATE_KEY, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  const derivedPublicKey = createPublicKey(privateKey)
    .export({ format: 'der', type: 'spki' })
    .subarray(-32)
    .toString('base64url');

  assert.equal(environment.DISCORD_RELAY_CURRENT_PUBLIC_KEY, derivedPublicKey);
});
