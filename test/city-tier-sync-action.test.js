import test from 'node:test';
import assert from 'node:assert/strict';
import * as cityTierSync from '../src/services/queueActions/cityTierSync.js';
import { createLogger } from './helpers.js';

const ROLE_ONE = '123456789012345671';
const ROLE_TWO = '123456789012345672';
const LEGACY_ROLE = '123456789012345673';
const MEMBER_ONE = '223456789012345671';
const MEMBER_TWO = '223456789012345672';
const OUTSIDER = '223456789012345673';
const MISSING_MEMBER = '223456789012345674';

const payload = () => ({
  contract_version: 1,
  bucket_size: 10,
  roles: [
    {
      bucket_start: 1,
      bucket_end: 10,
      name: 'Cities 1-10',
      discord_role_id: ROLE_ONE,
    },
    {
      bucket_start: 11,
      bucket_end: 20,
      name: 'Cities 11-20',
      discord_role_id: null,
    },
  ],
  members: [
    { discord_id: MEMBER_ONE, bucket_start: 1 },
    { discord_id: MEMBER_TWO, bucket_start: 11 },
    { discord_id: MISSING_MEMBER, bucket_start: 11 },
  ],
  managed_role_ids: [ROLE_ONE, LEGACY_ROLE],
});

test('CITY_TIER_SYNC validates a complete versioned snapshot', () => {
  const validPayload = payload();
  assert.deepEqual(cityTierSync.validate(validPayload), { valid: true });
  assert.deepEqual(cityTierSync.validate({ ...validPayload, contract_version: 2 }), {
    valid: false,
    reason: 'invalid_contract_version',
  });
  assert.deepEqual(cityTierSync.validate({
    ...validPayload,
    managed_role_ids: [LEGACY_ROLE],
  }), { valid: false, reason: 'unmanaged_configured_role' });
  assert.deepEqual(cityTierSync.validate({
    ...validPayload,
    members: [...validPayload.members, { discord_id: MEMBER_ONE, bucket_start: 1 }],
  }), { valid: false, reason: 'duplicate_member' });
});

test('CITY_TIER_SYNC creates missing tiers and reconciles only managed role IDs', async () => {
  const roleOne = manageableRole(ROLE_ONE);
  const legacyRole = manageableRole(LEGACY_ROLE);
  const guildRoles = new Map([
    [ROLE_ONE, roleOne],
    [LEGACY_ROLE, legacyRole],
  ]);
  const memberOne = member(MEMBER_ONE, [LEGACY_ROLE, '999999999999999991']);
  const memberTwo = member(MEMBER_TWO, [ROLE_ONE, '999999999999999992']);
  const outsider = member(OUTSIDER, [LEGACY_ROLE, '999999999999999993']);
  const guildMembers = new Map([
    [MEMBER_ONE, memberOne],
    [MEMBER_TWO, memberTwo],
    [OUTSIDER, outsider],
  ]);
  const guild = {
    id: '323456789012345678',
    roles: {
      fetch: async () => guildRoles,
      create: async ({ name }) => {
        const role = { ...manageableRole(ROLE_TWO), name };
        guildRoles.set(role.id, role);
        return role;
      },
    },
    members: { fetch: async () => guildMembers },
  };
  const checkpoints = [];
  const runtime = {
    logger: createLogger(),
    resolveGuild: async () => guild,
    withDiscordRetry: async (operation) => operation(),
    canContinue: () => true,
    apiService: {
      checkpointDiscordQueue: async (...args) => checkpoints.push(args),
    },
  };

  const result = await cityTierSync.execute({
    id: 'queue-city-tier',
    lease_token: 'lease-token',
    payload: payload(),
  }, runtime);

  assert.deepEqual(result, {
    success: true,
    result: {
      roles: [
        { bucket_start: 1, bucket_end: 10, discord_role_id: ROLE_ONE },
        { bucket_start: 11, bucket_end: 20, discord_role_id: ROLE_TWO },
      ],
      roles_created: 1,
      members_updated: 3,
      members_unavailable: 1,
      members_unmanageable: 0,
    },
  });
  assert.deepEqual(Array.from(memberOne.roles.cache.keys()).sort(), [
    ROLE_ONE,
    '999999999999999991',
  ].sort());
  assert.deepEqual(Array.from(memberTwo.roles.cache.keys()).sort(), [
    ROLE_TWO,
    '999999999999999992',
  ].sort());
  assert.deepEqual(Array.from(outsider.roles.cache.keys()), ['999999999999999993']);
  assert.deepEqual(checkpoints, [[
    'queue-city-tier',
    'lease-token',
    {
      roles: [
        { bucket_start: 1, bucket_end: 10, discord_role_id: ROLE_ONE },
        { bucket_start: 11, bucket_end: 20, discord_role_id: ROLE_TWO },
      ],
    },
  ]]);
});

test('CITY_TIER_SYNC resumes from a durable role checkpoint without creating a duplicate', async () => {
  const guildRoles = new Map([
    [ROLE_ONE, manageableRole(ROLE_ONE)],
    [ROLE_TWO, manageableRole(ROLE_TWO)],
    [LEGACY_ROLE, manageableRole(LEGACY_ROLE)],
  ]);
  let createCalls = 0;
  const runtime = {
    logger: createLogger(),
    resolveGuild: async () => ({
      roles: {
        fetch: async () => guildRoles,
        create: async () => {
          createCalls += 1;
          return manageableRole('123456789012345679');
        },
      },
      members: { fetch: async () => new Map() },
    }),
    withDiscordRetry: async (operation) => operation(),
    canContinue: () => true,
  };

  const result = await cityTierSync.execute({
    id: 'queue-resume',
    lease_token: 'lease-token',
    payload: { ...payload(), members: [] },
    result: {
      roles: [{ bucket_start: 11, bucket_end: 20, discord_role_id: ROLE_TWO }],
    },
  }, runtime);

  assert.equal(result.success, true);
  assert.equal(result.result.roles_created, 0);
  assert.equal(createCalls, 0);
});

test('CITY_TIER_SYNC rejects a persisted role that the bot cannot safely manage', async () => {
  const unsafeRole = { ...manageableRole(ROLE_ONE), managed: true };
  const guildRoles = new Map([
    [ROLE_ONE, unsafeRole],
    [LEGACY_ROLE, manageableRole(LEGACY_ROLE)],
  ]);
  const runtime = {
    logger: createLogger(),
    resolveGuild: async () => ({
      roles: {
        fetch: async () => guildRoles,
        create: async () => manageableRole(ROLE_TWO),
      },
      members: { fetch: async () => new Map() },
    }),
    withDiscordRetry: async (operation) => operation(),
    canContinue: () => true,
  };

  assert.deepEqual(
    await cityTierSync.execute({ id: 'queue-unsafe-role', payload: payload() }, runtime),
    { success: false, reason: 'role_unmanageable' },
  );
});

const manageableRole = (id) => ({ id, editable: true, managed: false });

const member = (id, roleIds) => {
  const cache = new Map(roleIds.map((roleId) => [roleId, { id: roleId }]));
  return {
    id,
    manageable: true,
    roles: {
      cache,
      add: async (roleId) => {
        cache.set(roleId, { id: roleId });
      },
      remove: async (removedRoleIds) => {
        for (const roleId of removedRoleIds) cache.delete(roleId);
      },
    },
  };
};
