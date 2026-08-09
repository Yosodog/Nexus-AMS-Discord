import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { execute, help } from '../src/commands/nexus.js';
import { CONNECTION_MODES } from '../src/services/connection/ConnectionContext.js';
import { ConnectionResolver } from '../src/services/connection/ConnectionResolver.js';
import { DiscordStatusService } from '../src/services/status/DiscordStatusService.js';
import { createLogger, embedJson } from './helpers.js';

const APP_ID = '123456789012345678';
const FOREIGN_APP_ID = '923456789012345678';
const GUILD_A = '223456789012345678';
const GUILD_B = '323456789012345678';
const USER_ID = '423456789012345678';
const CONNECTION_A = '11111111-2222-4333-8444-555555555555';
const CONNECTION_B = '66666666-7777-4888-8999-000000000000';

const connection = ({
  connectionId = CONNECTION_A,
  applicationId = APP_ID,
  guildId = GUILD_A,
  keyId = 'relay-current-a',
} = {}) => ({
  mode: CONNECTION_MODES.OFFICIAL_SHARED,
  connectionId,
  applicationId,
  guildId,
  generation: 7,
  protocolVersion: 2,
  keyId,
  endpointOrigin: 'https://nexus.example',
  state: 'active',
  capabilities: { commands: { nexus: 1 } },
  updatedAt: '2026-08-08T11:59:00.000Z',
  expiresAt: '2026-08-08T12:05:00.000Z',
});

const localStatus = ({ connected = true } = {}) => ({
  gateway: { ready: true, status: 0 },
  routing: {
    mode: CONNECTION_MODES.OFFICIAL_SHARED,
    connected,
    state: connected ? 'active' : 'unconfigured',
    active_connections: connected ? 1 : 0,
  },
  discord: {
    observed: true,
    permissions: { observed: true, granted: ['view_channel', 'send_messages'] },
  },
});

const interaction = ({ permissions = [] } = {}) => {
  const replies = [];
  return {
    guildId: GUILD_A,
    id: '523456789012345678',
    commandName: 'nexus',
    user: { id: USER_ID },
    options: { getSubcommand: () => 'status' },
    memberPermissions: {
      has: (permission) => permissions.includes(permission),
    },
    reply: async (payload) => { replies.push(payload); return payload; },
    replies,
  };
};

const description = (value) => embedJson(value.replies[0])?.description ?? '';

test('status service scopes routing to the current guild and emits no installation identifiers', () => {
  const resolver = new ConnectionResolver({
    mode: CONNECTION_MODES.OFFICIAL_SHARED,
    applicationId: APP_ID,
    connections: [
      connection(),
      connection({ connectionId: CONNECTION_B, guildId: GUILD_B, keyId: 'relay-current-b' }),
      connection({
        connectionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        applicationId: FOREIGN_APP_ID,
        keyId: 'relay-foreign-app',
      }),
    ],
    clock: () => Date.parse('2026-08-08T12:00:00Z'),
  });
  const service = new DiscordStatusService({
    client: {
      ws: { status: 0 },
      readyAt: new Date(),
      guilds: {
        cache: new Map([
          [GUILD_A, { members: { me: { permissions: { has: () => true } } } }],
          [GUILD_B, { members: { me: { permissions: { has: () => true } } } }],
        ]),
      },
    },
    connectionResolver: resolver,
  });

  const status = service.getStatus({ guildId: GUILD_A });
  const serialized = JSON.stringify(status);

  assert.equal(status.routing.connected, true);
  assert.equal(status.routing.active_connections, 1);
  assert.doesNotMatch(serialized, /connection_id|application_id|key_id|guild_id/i);
  assert.doesNotMatch(serialized, new RegExp([
    APP_ID, FOREIGN_APP_ID, GUILD_A, GUILD_B, CONNECTION_A, CONNECTION_B,
    'relay-current-a', 'relay-current-b', 'relay-foreign-app',
  ].join('|')));
  assert.equal(status.gateway.guild_count, undefined);
});

test('connected status renders no local diagnostics for forbidden, unlinked, or unavailable providers', async (t) => {
  const failures = [
    { name: 'forbidden', error: Object.assign(new Error('forbidden'), {
      response: { status: 403, data: { error: { code: 'forbidden' } } },
    }) },
    { name: 'unlinked', error: Object.assign(new Error('unlinked'), {
      response: { status: 403, data: { error: { code: 'discord_actor_not_linked' } } },
    }) },
    { name: 'unavailable', error: Object.assign(new Error('unavailable'), { code: 'ECONNREFUSED' }) },
  ];

  for (const failure of failures) {
    await t.test(failure.name, async () => {
      const value = interaction({ permissions: [PermissionFlagsBits.Administrator] });
      await execute(value, {
        statusService: { getStatus: () => localStatus() },
        apiService: { getNexusStatus: async () => { throw failure.error; } },
        logger: createLogger(),
      });

      assert.equal(value.replies[0].ephemeral, true);
      assert.match(description(value), /Nexus.*authorize|not authorized/i);
      assert.doesNotMatch(description(value), /Gateway:|Route mode:|Bot permissions:|active connections/i);
    });
  }
});

test('unconnected status renders no setup diagnostics to a non-manager', async () => {
  const value = interaction();
  let providerCalled = false;
  await execute(value, {
    statusService: { getStatus: () => localStatus({ connected: false }) },
    apiService: { getNexusStatus: async () => { providerCalled = true; } },
    logger: createLogger(),
  });

  assert.equal(providerCalled, false);
  assert.match(description(value), /Administrator|Manage Server|server manager/i);
  assert.doesNotMatch(description(value), /Gateway:|Route mode:|Bot permissions:|active connections/i);
});

test('authorized connected status and manager setup status retain their legitimate diagnostics', async () => {
  const connected = interaction();
  await execute(connected, {
    statusService: { getStatus: () => localStatus() },
    apiService: {
      getNexusStatus: async () => ({
        data: {
          provider: {
            authorization_authority: 'nexus',
            status: 'available',
            version: '2026.08',
          },
        },
      }),
    },
    logger: createLogger(),
  });
  assert.match(description(connected), /Gateway:.*ready/i);
  assert.match(description(connected), /Nexus provider:.*available/i);

  const setup = interaction({ permissions: [PermissionFlagsBits.ManageGuild] });
  await execute(setup, {
    statusService: { getStatus: () => localStatus({ connected: false }) },
    apiService: { getNexusStatus: async () => assert.fail('provider must not be called before connection') },
    logger: createLogger(),
  });
  assert.match(description(setup), /Gateway:.*ready/i);
  assert.match(description(setup), /not connected|setup/i);

  const rendered = `${description(connected)}\n${description(setup)}`;
  assert.doesNotMatch(rendered, /connection_id|application_id|key_id|guild_id/i);
  assert.doesNotMatch(rendered, new RegExp([APP_ID, GUILD_A, CONNECTION_A].join('|')));
  assert.notEqual(help.audience, 'Everyone');
});
