import test from 'node:test';
import assert from 'node:assert/strict';
import {
  execute,
  validate,
} from '../src/services/queueActions/memberProfileSync.js';

const APPLICATION_ID = '123456789012345678';
const GUILD_ID = '223456789012345678';
const USER_ID = '323456789012345678';
const ADD_ROLE_ID = '423456789012345678';
const REMOVE_ROLE_ID = '523456789012345678';
const PRESERVED_ROLE_ID = '623456789012345678';
const CONNECTION_ID = '123e4567-e89b-12d3-a456-426614174000';
const PROFILE_REVISION = 'a'.repeat(64);

const payload = (overrides = {}) => {
  const base = {
    contract_version: 1,
    installation: {
      application_id: APPLICATION_ID,
      guild_id: GUILD_ID,
      connection_id: CONNECTION_ID,
      generation: 7,
    },
    member: {
      discord_user_id: USER_ID,
      nexus_user_id: 42,
      nation_id: 9001,
      profile_revision: PROFILE_REVISION,
    },
    desired: {
      nickname: 'Nexus Leader',
      roles: {
        managed: [ADD_ROLE_ID, REMOVE_ROLE_ID],
        add: [ADD_ROLE_ID],
        remove: [REMOVE_ROLE_ID],
      },
    },
  };
  return {
    ...base,
    ...overrides,
    installation: { ...base.installation, ...overrides.installation },
    member: { ...base.member, ...overrides.member },
    desired: {
      ...base.desired,
      ...overrides.desired,
      roles: { ...base.desired.roles, ...overrides.desired?.roles },
    },
  };
};

const commandFor = (input, result = {}) => ({
  id: 'profile-sync-queue-1',
  action: 'MEMBER_PROFILE_SYNC',
  lease_token: 'profile-sync-lease-1',
  guild_id: GUILD_ID,
  payload: input,
  result,
});

const makeRole = (id, overrides = {}) => ({
  id,
  managed: false,
  editable: true,
  manageable: true,
  guildId: GUILD_ID,
  ...overrides,
});

const makeRuntime = ({
  nickname = 'Old Name',
  memberRoles = [REMOVE_ROLE_ID, PRESERVED_ROLE_ID],
  memberManageable = true,
  roles = [],
  connectionContext = {},
  canContinue = () => true,
} = {}) => {
  const events = [];
  const checkpoints = [];
  const roleCache = new Map([
    [ADD_ROLE_ID, makeRole(ADD_ROLE_ID)],
    [REMOVE_ROLE_ID, makeRole(REMOVE_ROLE_ID)],
    [PRESERVED_ROLE_ID, makeRole(PRESERVED_ROLE_ID)],
    ...roles.map((role) => [role.id, role]),
  ]);
  const member = {
    id: USER_ID,
    guildId: GUILD_ID,
    nickname,
    manageable: memberManageable,
    roles: {
      cache: new Map(memberRoles.map((roleId) => [roleId, roleCache.get(roleId) ?? makeRole(roleId)])),
      add: async (roleIds) => {
        events.push(['roles_add', [...roleIds]]);
        for (const roleId of roleIds) member.roles.cache.set(roleId, roleCache.get(roleId));
      },
      remove: async (roleIds) => {
        events.push(['roles_remove', [...roleIds]]);
        for (const roleId of roleIds) member.roles.cache.delete(roleId);
      },
    },
    setNickname: async (value) => {
      events.push(['nickname', value]);
      member.nickname = value;
    },
  };
  const guild = {
    id: GUILD_ID,
    roles: {
      cache: roleCache,
      fetch: async (roleId) => roleCache.get(roleId) ?? null,
    },
    members: {
      fetch: async (userId) => (userId === USER_ID ? member : null),
    },
  };
  const runtime = {
    guildId: GUILD_ID,
    connectionContext: {
      applicationId: APPLICATION_ID,
      connectionId: CONNECTION_ID,
      generation: 7,
      ...connectionContext,
    },
    canContinue,
    resolveGuild: async () => guild,
    withDiscordRetry: async (operation) => operation(),
    apiService: {
      checkpointDiscordQueue: async (...args) => {
        checkpoints.push(args);
        return { success: true };
      },
    },
  };
  return { runtime, member, events, checkpoints };
};

test('validates a closed connection-bound profile sync contract', () => {
  assert.deepEqual(validate(payload()), { valid: true });
  assert.deepEqual(validate(payload({ unknown: true })), { valid: false, reason: 'invalid_payload' });
  assert.deepEqual(validate(payload({ desired: { nickname: 'x'.repeat(33) } })), {
    valid: false,
    reason: 'invalid_desired',
  });
  assert.deepEqual(validate(payload({
    desired: { roles: { managed: [], add: [ADD_ROLE_ID] } },
  })), { valid: false, reason: 'unmanaged_role_change' });
  assert.deepEqual(validate(payload({
    desired: { roles: { add: [ADD_ROLE_ID], remove: [ADD_ROLE_ID] } },
  })), { valid: false, reason: 'overlapping_role_changes' });
});

test('applies only Nexus-provided profile changes and preserves unmanaged roles', async () => {
  const { runtime, member, events, checkpoints } = makeRuntime();
  const result = await execute(commandFor(payload()), runtime);

  assert.equal(result.success, true);
  assert.equal(member.nickname, 'Nexus Leader');
  assert.deepEqual(events, [
    ['nickname', 'Nexus Leader'],
    ['roles_add', [ADD_ROLE_ID]],
    ['roles_remove', [REMOVE_ROLE_ID]],
  ]);
  assert.equal(member.roles.cache.has(ADD_ROLE_ID), true);
  assert.equal(member.roles.cache.has(REMOVE_ROLE_ID), false);
  assert.equal(member.roles.cache.has(PRESERVED_ROLE_ID), true);
  assert.deepEqual(result.result.observed.managed_role_ids, [ADD_ROLE_ID]);
  assert.equal(checkpoints.length, 4);
  assert.equal(checkpoints.at(-1)[2].member_profile_sync.nickname_applied, true);
});

test('replays an already-applied profile sync without duplicate Discord mutations', async () => {
  const { runtime, events } = makeRuntime({
    nickname: 'Nexus Leader',
    memberRoles: [ADD_ROLE_ID, PRESERVED_ROLE_ID],
  });
  const result = await execute(commandFor(payload(), {
    member_profile_sync: {
      profile_revision: PROFILE_REVISION,
      nickname_applied: true,
      roles_added: [ADD_ROLE_ID],
      roles_removed: [REMOVE_ROLE_ID],
    },
  }), runtime);

  assert.equal(result.success, true);
  assert.deepEqual(events, []);
});

test('reconciles Discord drift even when a previous checkpoint recorded completion', async () => {
  const { runtime, events, member } = makeRuntime();
  const result = await execute(commandFor(payload(), {
    member_profile_sync: {
      profile_revision: PROFILE_REVISION,
      nickname_applied: true,
      roles_added: [ADD_ROLE_ID],
      roles_removed: [REMOVE_ROLE_ID],
    },
  }), runtime);

  assert.equal(result.success, true);
  assert.equal(member.nickname, 'Nexus Leader');
  assert.deepEqual(events, [
    ['nickname', 'Nexus Leader'],
    ['roles_add', [ADD_ROLE_ID]],
    ['roles_remove', [REMOVE_ROLE_ID]],
  ]);
});

test('fails closed for a foreign connection or stale generation', async () => {
  const foreign = makeRuntime({ connectionContext: { connectionId: crypto.randomUUID() } });
  assert.equal((await execute(commandFor(payload()), foreign.runtime)).reason, 'wrong_connection');
  assert.deepEqual(foreign.events, []);

  const stale = makeRuntime({ connectionContext: { generation: 8 } });
  assert.equal((await execute(commandFor(payload()), stale.runtime)).reason, 'stale_connection_generation');
  assert.deepEqual(stale.events, []);

  const missing = makeRuntime();
  delete missing.runtime.connectionContext;
  assert.equal((await execute(commandFor(payload()), missing.runtime)).reason, 'wrong_application');
  assert.deepEqual(missing.events, []);
});

test('refuses unmanageable members and managed or missing Discord roles', async () => {
  const unmanageable = makeRuntime({ memberManageable: false });
  assert.equal((await execute(commandFor(payload()), unmanageable.runtime)).reason, 'member_unmanageable');

  const managed = makeRuntime({ roles: [makeRole(ADD_ROLE_ID, { managed: true })] });
  assert.equal((await execute(commandFor(payload()), managed.runtime)).reason, 'role_unmanageable');

  const missingPayload = payload({
    desired: { roles: { managed: [ADD_ROLE_ID], add: [ADD_ROLE_ID], remove: [] } },
  });
  const missing = makeRuntime({ roles: [{ id: ADD_ROLE_ID, missing: true }] });
  missing.runtime.resolveGuild = async () => ({
    id: GUILD_ID,
    roles: { cache: new Map(), fetch: async () => null },
    members: { fetch: async () => missing.member },
  });
  assert.equal((await execute(commandFor(missingPayload), missing.runtime)).reason, 'role_not_found');
});

test('reports lease loss after a partial profile mutation with reconciliation context', async () => {
  let continuationChecks = 0;
  const { runtime, events } = makeRuntime({
    canContinue: () => {
      continuationChecks += 1;
      return continuationChecks < 3;
    },
  });
  const result = await execute(commandFor(payload()), runtime);

  assert.equal(result.success, false);
  assert.equal(result.reason, 'lease_lost');
  assert.equal(result.reconciliation_required, true);
  assert.deepEqual(events, [['nickname', 'Nexus Leader']]);
  assert.equal(result.result.member_profile_sync.nickname_applied, true);
});
