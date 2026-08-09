import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConnectionContext } from '../src/services/connection/ConnectionContext.js';
import { ConnectionResolver, ConnectionResolutionError } from '../src/services/connection/ConnectionResolver.js';
import { ConnectionPublicationManager } from '../src/services/connection/ConnectionPublicationManager.js';
import { FileConnectionPublicationSource } from '../src/services/connection/FileConnectionPublicationSource.js';
import { createLogger } from './helpers.js';

const APP_ID = '123456789012345678';
const GUILD_ID = '223456789012345678';
const CONNECTION_A = '11111111-2222-4333-8444-555555555555';
const CONNECTION_B = '66666666-7777-4777-8888-999999999999';
const TEST_NOW = Date.parse('2026-08-08T12:00:00.000Z');

const rawConnection = (overrides = {}) => ({
  mode: 'official-shared',
  protocolVersion: 2,
  applicationId: APP_ID,
  guildId: GUILD_ID,
  connectionId: CONNECTION_A,
  generation: 7,
  keyId: 'relay-current',
  endpointOrigin: 'https://nexus.example',
  expiresAt: '2026-08-08T13:00:00.000Z',
  capabilities: { commands: { nexus: 1 } },
  serviceOptions: {
    apiKey: 'private-api-key-a',
    relayPrivateKey: 'private-relay-key-a',
  },
  ...overrides,
});

const buildConnection = (raw) => createConnectionContext(raw);

const sequenceSource = (...snapshots) => {
  let index = 0;
  return {
    read: async () => {
      const value = snapshots[Math.min(index, snapshots.length - 1)];
      index += 1;
      if (value instanceof Error) throw value;
      return structuredClone(value);
    },
  };
};

test('file publication source accepts a bounded array and rejects duplicate keys and oversized files', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nexus-discord-connections-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'connections.json');
  const source = new FileConnectionPublicationSource({ filePath, maxBytes: 4096 });

  await writeFile(filePath, JSON.stringify([rawConnection()]));
  const valid = await source.read();
  assert.equal(valid.length, 1);
  assert.equal(valid[0].connectionId, CONNECTION_A);

  await writeFile(filePath, '[{"generation":7,"generation":8}]');
  await assert.rejects(
    source.read(),
    (error) => error.code === 'INVALID_CONNECTION_PUBLICATION',
  );

  const smallSource = new FileConnectionPublicationSource({ filePath, maxBytes: 16 });
  await writeFile(filePath, JSON.stringify([rawConnection()]));
  await assert.rejects(
    smallSource.read(),
    (error) => error.code === 'CONNECTION_PUBLICATION_TOO_LARGE',
  );
});

test('manager atomically applies changed snapshots and permits same-binding credential rotation', async () => {
  const logger = createLogger();
  const resolver = new ConnectionResolver({
    mode: 'official-shared',
    applicationId: APP_ID,
    clock: () => TEST_NOW,
  });
  const accepted = [];
  const initial = [rawConnection()];
  const rotated = [rawConnection({
    keyId: 'relay-next',
    serviceOptions: {
      apiKey: 'private-api-key-b',
      relayPrivateKey: 'private-relay-key-b',
    },
  })];
  const manager = new ConnectionPublicationManager({
    source: sequenceSource(initial, initial, rotated),
    resolver,
    applicationId: APP_ID,
    buildConnection,
    logger,
    clock: () => TEST_NOW,
    onAccepted: (connections) => accepted.push(connections),
  });

  assert.deepEqual(await manager.refresh(), { accepted: true, changed: true, connectionCount: 1 });
  assert.equal(resolver.resolve({ guildId: GUILD_ID }).keyId, 'relay-current');
  assert.deepEqual(await manager.refresh(), { accepted: true, changed: false, connectionCount: 1 });
  assert.equal(accepted.length, 1);

  assert.deepEqual(await manager.refresh(), { accepted: true, changed: true, connectionCount: 1 });
  assert.equal(resolver.resolve({ guildId: GUILD_ID }).keyId, 'relay-next');
  assert.equal(accepted.length, 2);

  const serializedLogs = JSON.stringify(logger.entries);
  assert.doesNotMatch(serializedLogs, /private-api-key|private-relay-key/);
});

test('manager requires explicit file context and retains routes when active credentials do not validate', async () => {
  const resolver = new ConnectionResolver({
    mode: 'official-shared',
    applicationId: APP_ID,
    clock: () => TEST_NOW,
  });
  const missingApplication = rawConnection();
  delete missingApplication.applicationId;
  const foreignApplication = rawConnection({ applicationId: '423456789012345678' });
  const invalidCredentials = rawConnection({
    generation: 8,
    serviceOptions: { apiKey: '' },
  });
  const manager = new ConnectionPublicationManager({
    source: sequenceSource(
      [rawConnection()],
      [missingApplication],
      [foreignApplication],
      [invalidCredentials],
    ),
    resolver,
    applicationId: APP_ID,
    buildConnection,
    validateConnection: (connection) => connection.serviceOptions?.apiKey !== '',
    logger: createLogger(),
    clock: () => TEST_NOW,
  });

  assert.equal((await manager.refresh()).accepted, true);
  assert.equal(resolver.resolve({ guildId: GUILD_ID }).generation, 7);

  const incomplete = await manager.refresh();
  assert.equal(incomplete.accepted, false);
  assert.equal(incomplete.errorCode, 'INCOMPLETE_CONNECTION_PUBLICATION');
  assert.equal(resolver.resolve({ guildId: GUILD_ID }).generation, 7);

  const foreign = await manager.refresh();
  assert.equal(foreign.accepted, false);
  assert.equal(foreign.errorCode, 'FOREIGN_DISCORD_APPLICATION');
  assert.equal(resolver.resolve({ guildId: GUILD_ID }).generation, 7);

  const invalid = await manager.refresh();
  assert.equal(invalid.accepted, false);
  assert.equal(invalid.errorCode, 'INVALID_CONNECTION_CREDENTIALS');
  assert.equal(resolver.resolve({ guildId: GUILD_ID }).generation, 7);
});

test('manager retains last-known-good routes for malformed, ambiguous, and rollback snapshots until expiry', async () => {
  let now = Date.parse('2026-08-08T12:00:00.000Z');
  const malformed = Object.assign(new Error('contains private-api-key-a'), { code: 'INVALID_CONNECTION_PUBLICATION' });
  const ambiguous = [
    rawConnection({ generation: 8 }),
    rawConnection({ connectionId: CONNECTION_B, generation: 9 }),
  ];
  const rollback = [rawConnection({ generation: 6 })];
  const resolver = new ConnectionResolver({
    mode: 'official-shared',
    applicationId: APP_ID,
    clock: () => now,
  });
  const logger = createLogger();
  const manager = new ConnectionPublicationManager({
    source: sequenceSource([rawConnection()], malformed, ambiguous, rollback),
    resolver,
    applicationId: APP_ID,
    buildConnection,
    logger,
    clock: () => now,
  });

  await manager.refresh();
  assert.equal(resolver.resolve({ guildId: GUILD_ID }).generation, 7);

  for (const expectedCode of [
    'INVALID_CONNECTION_PUBLICATION',
    'AMBIGUOUS_ACTIVE_CONNECTION',
    'CONNECTION_GENERATION_ROLLBACK',
  ]) {
    const result = await manager.refresh();
    assert.equal(result.accepted, false);
    assert.equal(result.errorCode, expectedCode);
    assert.equal(resolver.resolve({ guildId: GUILD_ID }).generation, 7);
  }

  now = Date.parse('2026-08-08T13:00:01.000Z');
  assert.throws(
    () => resolver.resolve({ guildId: GUILD_ID }),
    (error) => error instanceof ConnectionResolutionError && error.code === 'STALE_CONNECTION',
  );
  assert.doesNotMatch(JSON.stringify(logger.entries), /private-api-key-a/);
});

test('empty publication revokes routes immediately and requires a newer generation to reactivate', async () => {
  const resolver = new ConnectionResolver({
    mode: 'official-shared',
    applicationId: APP_ID,
    clock: () => TEST_NOW,
  });
  const manager = new ConnectionPublicationManager({
    source: sequenceSource(
      [rawConnection()],
      [],
      [rawConnection()],
      [rawConnection({ generation: 8 })],
    ),
    resolver,
    applicationId: APP_ID,
    buildConnection,
    logger: createLogger(),
    clock: () => TEST_NOW,
  });

  await manager.refresh();
  assert.equal(resolver.resolve({ guildId: GUILD_ID }).generation, 7);

  assert.deepEqual(await manager.refresh(), { accepted: true, changed: true, connectionCount: 0 });
  assert.throws(
    () => resolver.resolve({ guildId: GUILD_ID }),
    (error) => error instanceof ConnectionResolutionError && error.code === 'CONNECTION_NOT_FOUND',
  );

  const replay = await manager.refresh();
  assert.equal(replay.accepted, false);
  assert.equal(replay.errorCode, 'REVOKED_CONNECTION_GENERATION');
  assert.throws(() => resolver.resolve({ guildId: GUILD_ID }), /No Nexus connection/);

  assert.deepEqual(await manager.refresh(), { accepted: true, changed: true, connectionCount: 1 });
  assert.equal(resolver.resolve({ guildId: GUILD_ID }).generation, 8);
});

test('manager rejects an older active route behind a newer fenced generation and cross-guild connection reuse', async () => {
  const otherGuild = '323456789012345678';
  const resolver = new ConnectionResolver({
    mode: 'official-shared',
    applicationId: APP_ID,
    clock: () => TEST_NOW,
  });
  const manager = new ConnectionPublicationManager({
    source: sequenceSource(
      [
        rawConnection(),
        rawConnection({ connectionId: CONNECTION_B, generation: 8, state: 'revoked' }),
      ],
      [
        rawConnection(),
        rawConnection({ guildId: otherGuild, generation: 8, state: 'revoked' }),
      ],
    ),
    resolver,
    applicationId: APP_ID,
    buildConnection,
    logger: createLogger(),
    clock: () => TEST_NOW,
  });

  const rollback = await manager.refresh();
  assert.equal(rollback.accepted, false);
  assert.equal(rollback.errorCode, 'CONNECTION_STATE_ROLLBACK');
  assert.throws(() => resolver.resolve({ guildId: GUILD_ID }), /No Nexus connection/);

  const reused = await manager.refresh();
  assert.equal(reused.accepted, false);
  assert.equal(reused.errorCode, 'CONNECTION_IDENTITY_CONFLICT');
  assert.throws(() => resolver.resolve({ guildId: otherGuild }), /No Nexus connection/);
});

test('an expired publication cannot be revived by extending expiry at the same generation', async () => {
  let now = TEST_NOW;
  const initial = [rawConnection()];
  const resolver = new ConnectionResolver({
    mode: 'official-shared',
    applicationId: APP_ID,
    clock: () => now,
  });
  const manager = new ConnectionPublicationManager({
    source: sequenceSource(
      initial,
      initial,
      [rawConnection({ expiresAt: '2026-08-08T14:00:00.000Z' })],
      [rawConnection({ generation: 8, expiresAt: '2026-08-08T14:00:00.000Z' })],
    ),
    resolver,
    applicationId: APP_ID,
    buildConnection,
    logger: createLogger(),
    clock: () => now,
  });

  await manager.refresh();
  now = Date.parse('2026-08-08T13:00:01.000Z');
  assert.equal((await manager.refresh()).changed, false);
  assert.throws(() => resolver.resolve({ guildId: GUILD_ID }), /expired/);

  const sameGeneration = await manager.refresh();
  assert.equal(sameGeneration.accepted, false);
  assert.equal(sameGeneration.errorCode, 'REVOKED_CONNECTION_GENERATION');

  assert.equal((await manager.refresh()).accepted, true);
  assert.equal(resolver.resolve({ guildId: GUILD_ID }).generation, 8);
});

test('concurrent refreshes share one source read and stop waits for an in-flight refresh', async () => {
  let release;
  let reads = 0;
  const source = {
    read: async () => {
      reads += 1;
      await new Promise((resolve) => { release = resolve; });
      return [rawConnection()];
    },
  };
  const resolver = new ConnectionResolver({
    mode: 'official-shared',
    applicationId: APP_ID,
    clock: () => TEST_NOW,
  });
  const manager = new ConnectionPublicationManager({
    source,
    resolver,
    applicationId: APP_ID,
    buildConnection,
    logger: createLogger(),
    clock: () => TEST_NOW,
  });

  const first = manager.refresh();
  const second = manager.refresh();
  const stopping = manager.stop();
  assert.equal(reads, 1);
  release();

  assert.deepEqual(await first, await second);
  await stopping;
  assert.equal(resolver.resolve({ guildId: GUILD_ID }).generation, 7);
});
