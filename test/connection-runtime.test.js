import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionResolver, ConnectionResolutionError } from '../src/services/connection/ConnectionResolver.js';
import {
  CONNECTION_MODES,
  createConnectionContext,
  createDeliveryContext,
} from '../src/services/connection/ConnectionContext.js';
import { FairScheduler } from '../src/services/FairScheduler.js';
import { InteractionSessionStore } from '../src/services/InteractionSessionStore.js';
import { DiscordStatusService } from '../src/services/status/DiscordStatusService.js';
import { redactStatus } from '../src/services/status/DiscordStatusService.js';
import { registerInteractionListener } from '../src/listeners/interactionCreate.js';
import { Events } from 'discord.js';
import { createEventClient, createLogger } from './helpers.js';

const APP_ID = '123456789012345678';
const GUILD_A = '223456789012345678';
const GUILD_B = '323456789012345678';
const CONNECTION_A = '11111111-2222-4333-8444-555555555555';
const CONNECTION_B = '66666666-7777-4777-8888-999999999999';

test('shared mode aliases normalize to the official-shared wire value', () => {
  const normalized = createConnectionContext({
    mode: 'shared',
    protocolVersion: 2,
    applicationId: APP_ID,
    guildId: GUILD_A,
    connectionId: CONNECTION_A,
    generation: 7,
    keyId: 'relay-current',
    endpointOrigin: 'https://nexus.example:8443',
    expiresAt: '2099-08-08T13:00:00Z',
  });
  assert.equal(CONNECTION_MODES.OFFICIAL_SHARED, 'official-shared');
  assert.equal(CONNECTION_MODES.SHARED, 'official-shared');
  assert.equal(normalized.mode, 'official-shared');
});

const context = (overrides = {}) => createConnectionContext({
  mode: CONNECTION_MODES.SHARED,
  protocolVersion: 2,
  applicationId: APP_ID,
  guildId: GUILD_A,
  connectionId: CONNECTION_A,
  generation: 7,
  keyId: 'relay-current',
  endpointOrigin: 'https://nexus.example',
  capabilities: {
    commands: { nexus: 1, applications: 1 },
    capabilities: ['relay.proof.v2', 'queue.leases.v1'],
  },
  expiresAt: '2099-08-08T13:00:00Z',
  ...overrides,
});

test('shared resolver fails closed for zero, multiple, stale, foreign, and stale-generation bindings', () => {
  const now = Date.parse('2026-08-08T12:00:00Z');
  const primary = context();
  const resolver = new ConnectionResolver({
    mode: CONNECTION_MODES.SHARED,
    applicationId: APP_ID,
    connections: [primary],
    clock: () => now,
  });
  assert.equal(resolver.resolve({ guildId: GUILD_A, applicationId: APP_ID }).connectionId, CONNECTION_A);
  assert.throws(() => resolver.resolve({ guildId: GUILD_B, applicationId: APP_ID }), (error) => {
    assert.ok(error instanceof ConnectionResolutionError);
    return error.code === 'CONNECTION_NOT_FOUND';
  });
  assert.throws(() => resolver.resolve({ guildId: GUILD_A, applicationId: '923456789012345678' }), /not trusted/);

  resolver.add(context({ connectionId: CONNECTION_B, guildId: GUILD_A }));
  assert.throws(() => resolver.resolve({ guildId: GUILD_A, applicationId: APP_ID }), /Multiple Nexus connections/);

  const staleResolver = new ConnectionResolver({
    mode: CONNECTION_MODES.SHARED,
    applicationId: APP_ID,
    connections: [context({ expiresAt: '2026-08-08T11:59:00Z' })],
    clock: () => now,
  });
  assert.throws(() => staleResolver.resolve({ guildId: GUILD_A, applicationId: APP_ID }), /expired/);

  const freshResolver = new ConnectionResolver({
    mode: CONNECTION_MODES.SHARED,
    applicationId: APP_ID,
    connections: [primary],
    clock: () => now,
  });
  assert.throws(() => freshResolver.resolveDelivery({
    connection_id: CONNECTION_A,
    application_id: APP_ID,
    guild_id: GUILD_A,
    generation: 6,
    id: 'delivery-1',
  }), /stale connection generation/);
  assert.throws(() => freshResolver.resolveDelivery({
    connection_id: CONNECTION_B,
    application_id: APP_ID,
    guild_id: GUILD_A,
    generation: 7,
    id: 'delivery-2',
  }), /another connection/);
});

test('resolver selects one current publication over a fenced predecessor and rejects two current publications', () => {
  const now = Date.parse('2026-08-08T12:00:00Z');
  const predecessor = context({
    connectionId: CONNECTION_B,
    generation: 6,
    state: 'revoked',
  });
  const current = context({ generation: 7 });
  const resolver = new ConnectionResolver({
    mode: CONNECTION_MODES.SHARED,
    applicationId: APP_ID,
    connections: [predecessor, current],
    clock: () => now,
  });

  assert.equal(
    resolver.resolve({ guildId: GUILD_A, applicationId: APP_ID }).connectionId,
    CONNECTION_A,
  );

  resolver.add(context({ connectionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', generation: 8 }));
  assert.throws(
    () => resolver.resolve({ guildId: GUILD_A, applicationId: APP_ID }),
    (error) => error instanceof ConnectionResolutionError && error.code === 'AMBIGUOUS_CONNECTION',
  );
});

test('delivery and component contexts retain connection and generation bindings', () => {
  const connection = context();
  const delivery = createDeliveryContext(connection, {
    id: 'delivery-1',
    dedupe_key: 'dedupe-1',
    action: 'WAR_ALERT',
  });
  assert.deepEqual({
    connectionId: delivery.connectionId,
    generation: delivery.generation,
    guildId: delivery.guildId,
  }, { connectionId: CONNECTION_A, generation: 7, guildId: GUILD_A });

  const sessions = new InteractionSessionStore({ createToken: () => '11111111-2222-4333-8444-555555555555' });
  const scoped = sessions.forConnection(connection);
  const customId = scoped.create({ commandName: 'applications', userId: '423456789012345678', event: 'approve' });
  assert.ok(scoped.resolve(customId, '423456789012345678'));
  assert.equal(sessions.resolve(customId, '423456789012345678', context({ generation: 8 })), null);
});

test('deficit scheduling gives each active connection a bounded opportunity', () => {
  const scheduler = new FairScheduler({ quantum: 1 });
  scheduler.register(CONNECTION_A);
  scheduler.register(CONNECTION_B);
  assert.deepEqual(
    Array.from({ length: 8 }, () => scheduler.next([CONNECTION_A, CONNECTION_B])),
    [CONNECTION_A, CONNECTION_B, CONNECTION_A, CONNECTION_B, CONNECTION_A, CONNECTION_B, CONNECTION_A, CONNECTION_B],
  );
  assert.deepEqual(scheduler.next([CONNECTION_A]), CONNECTION_A);
  assert.deepEqual(scheduler.next([CONNECTION_B]), CONNECTION_B);
});

test('status output contains bot observations but redacts credentials and message content', () => {
  const resolver = new ConnectionResolver({
    mode: CONNECTION_MODES.SHARED,
    applicationId: APP_ID,
    connections: [context()],
    clock: () => Date.parse('2026-08-08T12:00:00Z'),
  });
  const service = new DiscordStatusService({
    client: {
      ws: { status: 0 },
      readyAt: new Date(),
      guilds: { cache: new Map([[GUILD_A, {
        members: { me: { permissions: { has: (name) => name === 'ViewChannel' } } },
      }]]) },
    },
    connectionResolver: resolver,
    config: { discord: { intents: { names: ['Guilds'], messageContent: false, guildMembers: false } } },
  });
  const status = service.getStatus({ guildId: GUILD_A });
  const serialized = JSON.stringify(redactStatus({ status, token: 'secret-token', content: 'private message' }));
  assert.match(serialized, /active_connections/);
  assert.doesNotMatch(serialized, /secret-token|private message|password|private_key/i);
});

test('shared interaction resolution injects explicit connection context into the existing command path', async () => {
  const connection = context({ capabilities: { commands: { ping: 1 } } });
  const resolver = new ConnectionResolver({ mode: CONNECTION_MODES.SHARED, applicationId: APP_ID, connections: [connection] });
  const client = createEventClient();
  const logger = createLogger();
  let received;
  registerInteractionListener(
    client,
    new Map([['ping', { execute: async (_interaction, commandContext) => { received = commandContext; } }]]),
    logger,
    { connectionResolver: resolver, applicationId: APP_ID, apiService: 'fallback' },
  );
  await client.handlers.get(Events.InteractionCreate)({
    commandName: 'ping',
    guildId: GUILD_A,
    user: { id: '423456789012345678' },
    isChatInputCommand: () => true,
  });

  assert.equal(received.applicationId, APP_ID);
  assert.equal(received.guildId, GUILD_A);
  assert.equal(received.connectionId, CONNECTION_A);
  assert.equal(received.generation, 7);
  assert.equal(received.connectionContext.connectionId, connection.connectionId);
});

test('ambiguous shared interaction resolution does not dispatch the command', async () => {
  const resolver = new ConnectionResolver({
    mode: CONNECTION_MODES.SHARED,
    applicationId: APP_ID,
    connections: [context(), context({ connectionId: CONNECTION_B })],
  });
  const client = createEventClient();
  let executed = false;
  let replied = false;
  registerInteractionListener(
    client,
    new Map([['ping', { execute: async () => { executed = true; } }]]),
    createLogger(),
    { connectionResolver: resolver, applicationId: APP_ID },
  );
  await client.handlers.get(Events.InteractionCreate)({
    commandName: 'ping',
    guildId: GUILD_A,
    isChatInputCommand: () => true,
    reply: async () => { replied = true; },
  });
  assert.equal(executed, false);
  assert.equal(replied, true);
});
