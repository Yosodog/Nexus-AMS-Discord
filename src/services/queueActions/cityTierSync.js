import { isDiscordSnowflake } from '../../utils/boundaryValidators.js';
import { invalid, valid } from './support.js';

const MAX_BUCKET_SIZE = 100;
const MAX_ROLES = 250;
const MAX_MEMBERS = 100_000;

export const validate = (payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return invalid('invalid_payload');
  }
  if (payload.contract_version !== 1) return invalid('invalid_contract_version');
  if (!Number.isInteger(payload.bucket_size)
    || payload.bucket_size < 1
    || payload.bucket_size > MAX_BUCKET_SIZE) {
    return invalid('invalid_bucket_size');
  }
  if (!Array.isArray(payload.roles) || payload.roles.length > MAX_ROLES) {
    return invalid('invalid_roles');
  }
  if (!Array.isArray(payload.members) || payload.members.length > MAX_MEMBERS) {
    return invalid('invalid_members');
  }
  if (!Array.isArray(payload.managed_role_ids) || payload.managed_role_ids.length > MAX_ROLES) {
    return invalid('invalid_managed_roles');
  }

  const bucketStarts = new Set();
  const configuredRoleIds = new Set();
  for (const role of payload.roles) {
    if (!isRoleDefinition(role)) return invalid('invalid_role');
    if (bucketStarts.has(role.bucket_start)) return invalid('duplicate_bucket');
    bucketStarts.add(role.bucket_start);

    if (role.discord_role_id !== null) {
      if (configuredRoleIds.has(role.discord_role_id)) return invalid('duplicate_role_id');
      configuredRoleIds.add(role.discord_role_id);
    }
  }

  const managedRoleIds = new Set();
  for (const roleId of payload.managed_role_ids) {
    if (!isDiscordSnowflake(roleId)) return invalid('invalid_managed_role_id');
    if (managedRoleIds.has(roleId)) return invalid('duplicate_managed_role_id');
    managedRoleIds.add(roleId);
  }
  for (const roleId of configuredRoleIds) {
    if (!managedRoleIds.has(roleId)) return invalid('unmanaged_configured_role');
  }

  const memberIds = new Set();
  for (const member of payload.members) {
    if (!member || typeof member !== 'object' || Array.isArray(member)) {
      return invalid('invalid_member');
    }
    if (!isDiscordSnowflake(member.discord_id)) return invalid('invalid_member_discord_id');
    if (!Number.isInteger(member.bucket_start) || !bucketStarts.has(member.bucket_start)) {
      return invalid('invalid_member_bucket');
    }
    if (memberIds.has(member.discord_id)) return invalid('duplicate_member');
    memberIds.add(member.discord_id);
  }

  return valid();
};

export const execute = async (command, runtime) => {
  const payload = command.payload;
  const guild = await runtime.resolveGuild();
  if (!guild) return { success: false, reason: 'guild_unavailable' };

  const checkpointRoleIds = checkpointRoles(command?.result, payload.roles);

  let guildRoles;
  let guildMembers;
  try {
    guildRoles = await runtime.withDiscordRetry(
      () => guild.roles.fetch(),
      'fetch CITY_TIER_SYNC guild roles',
    );
    guildMembers = await runtime.withDiscordRetry(
      () => guild.members.fetch(),
      'fetch CITY_TIER_SYNC guild members',
    );
  } catch (error) {
    runtime.logger.error('CITY_TIER_SYNC could not fetch guild state', {
      commandId: command?.id,
      error: error?.message ?? error,
    });
    return { success: false, reason: 'guild_state_unavailable' };
  }

  if (!runtime.canContinue()) return { success: false, reason: 'lease_lost' };

  const rolesByBucket = new Map();
  const managedRoleIds = new Set(payload.managed_role_ids);
  let rolesCreated = 0;

  try {
    for (const roleDefinition of payload.roles) {
      const persistedRoleId = checkpointRoleIds.get(roleDefinition.bucket_start)
        ?? roleDefinition.discord_role_id;
      let role = persistedRoleId
        ? guildRoles.get(persistedRoleId)
        : null;
      const mustCreateRole = !role;

      if (mustCreateRole) {
        if (!runtime.canContinue()) return { success: false, reason: 'lease_lost' };
        role = await runtime.withDiscordRetry(
          () => guild.roles.create({
            name: roleDefinition.name,
            reason: `Nexus AMS city tier ${roleDefinition.bucket_start}-${roleDefinition.bucket_end}`,
          }),
          `create CITY_TIER_SYNC role ${roleDefinition.name}`,
        );
      }

      if (!isManageableRole(role)) {
        runtime.logger.error('CITY_TIER_SYNC role is managed or above the bot role', {
          commandId: command?.id,
          roleId: role?.id ?? null,
          bucketStart: roleDefinition.bucket_start,
        });
        return { success: false, reason: 'role_unmanageable' };
      }

      managedRoleIds.add(role.id);
      rolesByBucket.set(roleDefinition.bucket_start, role);

      if (mustCreateRole) {
        guildRoles.set?.(role.id, role);
        rolesCreated += 1;

        const checkpoint = await checkpointCreatedRoles(command, runtime, payload.roles, rolesByBucket);
        if (!checkpoint.success) return checkpoint;
      }
    }

    for (const roleId of managedRoleIds) {
      const role = guildRoles.get(roleId);
      if (role && !isManageableRole(role)) {
        runtime.logger.error('CITY_TIER_SYNC legacy managed role is no longer editable', {
          commandId: command?.id,
          roleId,
        });
        return { success: false, reason: 'role_unmanageable' };
      }
    }
  } catch (error) {
    runtime.logger.error('CITY_TIER_SYNC could not prepare managed roles', {
      commandId: command?.id,
      error: error?.message ?? error,
    });
    return { success: false, reason: 'role_reconciliation_failed' };
  }

  const desiredRoles = new Map(payload.members.map((member) => [
    member.discord_id,
    rolesByBucket.get(member.bucket_start)?.id ?? null,
  ]));
  const presentMemberIds = new Set(guildMembers.keys());
  let membersUpdated = 0;
  let membersUnmanageable = 0;

  try {
    for (const member of guildMembers.values()) {
      const desiredRoleId = desiredRoles.get(member.id) ?? null;
      const currentManagedRoleIds = Array.from(member.roles.cache.keys())
        .filter((roleId) => managedRoleIds.has(roleId));
      const roleIdsToRemove = currentManagedRoleIds
        .filter((roleId) => roleId !== desiredRoleId);
      const needsDesiredRole = desiredRoleId !== null
        && !member.roles.cache.has(desiredRoleId);

      if (!needsDesiredRole && roleIdsToRemove.length === 0) continue;

      if (member.manageable === false) {
        membersUnmanageable += 1;
        runtime.logger.warn('CITY_TIER_SYNC cannot update an unmanageable guild member', {
          commandId: command?.id,
          discordId: member.id,
        });
        continue;
      }

      if (!runtime.canContinue()) return { success: false, reason: 'lease_lost' };
      if (needsDesiredRole) {
        await runtime.withDiscordRetry(
          () => member.roles.add(desiredRoleId, 'Nexus AMS city-tier synchronization'),
          'add CITY_TIER_SYNC member role',
        );
      }
      if (roleIdsToRemove.length > 0) {
        await runtime.withDiscordRetry(
          () => member.roles.remove(roleIdsToRemove, 'Nexus AMS city-tier synchronization'),
          'remove obsolete CITY_TIER_SYNC member roles',
        );
      }
      membersUpdated += 1;
    }
  } catch (error) {
    runtime.logger.error('CITY_TIER_SYNC member reconciliation failed', {
      commandId: command?.id,
      error: error?.message ?? error,
    });
    return { success: false, reason: 'member_reconciliation_failed' };
  }

  const membersUnavailable = Array.from(desiredRoles.keys())
    .filter((discordId) => !presentMemberIds.has(discordId))
    .length;

  runtime.logger.info('CITY_TIER_SYNC reconciliation completed', {
    commandId: command?.id,
    rolesCreated,
    membersUpdated,
    membersUnavailable,
    membersUnmanageable,
  });

  return {
    success: true,
    result: {
      roles: payload.roles.map((role) => ({
        bucket_start: role.bucket_start,
        bucket_end: role.bucket_end,
        discord_role_id: rolesByBucket.get(role.bucket_start).id,
      })),
      roles_created: rolesCreated,
      members_updated: membersUpdated,
      members_unavailable: membersUnavailable,
      members_unmanageable: membersUnmanageable,
    },
  };
};

const isRoleDefinition = (role) => role
  && typeof role === 'object'
  && !Array.isArray(role)
  && Number.isInteger(role.bucket_start)
  && role.bucket_start > 0
  && Number.isInteger(role.bucket_end)
  && role.bucket_end >= role.bucket_start
  && typeof role.name === 'string'
  && role.name.length > 0
  && role.name.length <= 100
  && (role.discord_role_id === null || isDiscordSnowflake(role.discord_role_id));

const isManageableRole = (role) => role
  && role.managed !== true
  && role.editable !== false;

const checkpointRoles = (result, roleDefinitions) => {
  const expectedBuckets = new Set(roleDefinitions.map((role) => role.bucket_start));
  const roles = new Map();
  if (!result || !Array.isArray(result.roles)) return roles;

  for (const role of result.roles) {
    if (role
      && Number.isInteger(role.bucket_start)
      && expectedBuckets.has(role.bucket_start)
      && isDiscordSnowflake(role.discord_role_id)) {
      roles.set(role.bucket_start, role.discord_role_id);
    }
  }
  return roles;
};

const checkpointCreatedRoles = async (command, runtime, roleDefinitions, rolesByBucket) => {
  if (!runtime.apiService?.checkpointDiscordQueue || !command?.lease_token) {
    runtime.logger.error('CITY_TIER_SYNC created a role without a durable queue checkpoint', {
      commandId: command?.id,
      reconciliationRequired: true,
    });
    return { success: false, reason: 'checkpoint_unavailable' };
  }

  const roles = roleDefinitions
    .filter((definition) => rolesByBucket.has(definition.bucket_start))
    .map((definition) => ({
      bucket_start: definition.bucket_start,
      bucket_end: definition.bucket_end,
      discord_role_id: rolesByBucket.get(definition.bucket_start).id,
    }));

  try {
    await runtime.apiService.checkpointDiscordQueue(command.id, command.lease_token, { roles });
    return { success: true };
  } catch (error) {
    runtime.logger.error('CITY_TIER_SYNC role was created but checkpoint failed', {
      commandId: command?.id,
      reconciliationRequired: true,
      status: error?.response?.status ?? null,
    });
    return { success: false, reason: 'checkpoint_failed' };
  }
};
