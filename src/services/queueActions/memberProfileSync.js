import { isDiscordSnowflake, isUuid } from '../../utils/boundaryValidators.js';

const TOP_LEVEL_KEYS = ['contract_version', 'installation', 'member', 'desired'];
const INSTALLATION_KEYS = ['application_id', 'guild_id', 'connection_id', 'generation'];
const MEMBER_KEYS = ['discord_user_id', 'nexus_user_id', 'nation_id', 'profile_revision'];
const DESIRED_KEYS = ['nickname', 'roles'];
const ROLE_KEYS = ['managed', 'add', 'remove'];
const CHECKPOINT_KEYS = ['profile_revision', 'nickname_applied', 'roles_added', 'roles_removed'];
const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
]);
const PERMISSION_ERROR_CODES = new Set([50001, 50013]);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = (reason) => ({ valid: false, reason });
const valid = () => ({ valid: true });

const hasOnlyKeys = (value, required, optional = []) => {
  if (!isObject(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
};

const isPositiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const isProfileRevision = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const normalizeSnowflake = (value) => (isDiscordSnowflake(value) ? value.trim() : null);

const validateSnowflakeList = (value, reason) => {
  if (!Array.isArray(value) || value.length > 100) return invalid(reason);
  const normalized = value.map(normalizeSnowflake);
  if (normalized.some((item) => item === null)) return invalid(reason);
  if (new Set(normalized).size !== normalized.length) return invalid(reason);
  return valid();
};

const validateRoles = (roles) => {
  if (!hasOnlyKeys(roles, ROLE_KEYS)) return invalid('invalid_roles');
  for (const [key, reason] of [
    ['managed', 'invalid_managed_roles'],
    ['add', 'invalid_role_additions'],
    ['remove', 'invalid_role_removals'],
  ]) {
    const result = validateSnowflakeList(roles[key], reason);
    if (!result.valid) return result;
  }

  const managed = new Set(roles.managed.map((roleId) => roleId.trim()));
  const additions = new Set(roles.add.map((roleId) => roleId.trim()));
  if (roles.add.some((roleId) => !managed.has(roleId.trim()))
    || roles.remove.some((roleId) => !managed.has(roleId.trim()))) {
    return invalid('unmanaged_role_change');
  }
  if (roles.remove.some((roleId) => additions.has(roleId.trim()))) {
    return invalid('overlapping_role_changes');
  }
  return valid();
};

export const validate = (payload) => {
  if (!hasOnlyKeys(payload, TOP_LEVEL_KEYS)) return invalid('invalid_payload');
  if (payload.contract_version !== 1) return invalid('invalid_contract_version');
  if (!hasOnlyKeys(payload.installation, INSTALLATION_KEYS)
    || !isDiscordSnowflake(payload.installation.application_id)
    || !isDiscordSnowflake(payload.installation.guild_id)
    || !isUuid(payload.installation.connection_id)
    || !isPositiveInteger(payload.installation.generation)) {
    return invalid('invalid_installation');
  }
  if (!hasOnlyKeys(payload.member, MEMBER_KEYS)
    || !isDiscordSnowflake(payload.member.discord_user_id)
    || !isPositiveInteger(payload.member.nexus_user_id)
    || !isPositiveInteger(payload.member.nation_id)
    || !isProfileRevision(payload.member.profile_revision)) {
    return invalid('invalid_member');
  }
  if (!hasOnlyKeys(payload.desired, DESIRED_KEYS)
    || typeof payload.desired.nickname !== 'string'
    || payload.desired.nickname.trim() !== payload.desired.nickname
    || payload.desired.nickname.length < 1
    || payload.desired.nickname.length > 32
    || /[\u0000-\u001F\u007F]/.test(payload.desired.nickname)) {
    return invalid('invalid_desired');
  }
  return validateRoles(payload.desired.roles);
};

const failure = (reason, {
  retryable = false,
  reconciliationRequired = false,
  checkpoint = null,
} = {}) => {
  const response = { success: false, reason, retryable };
  if (reconciliationRequired || checkpoint) {
    response.reconciliation_required = reconciliationRequired;
  }
  if (checkpoint) {
    response.result = {
      member_profile_sync: checkpoint,
      reconciliation_required: reconciliationRequired,
    };
  }
  return response;
};

const success = (checkpoint, member, managedRoleIds) => {
  const current = memberRoleIds(member);
  return {
    success: true,
    result: {
      member_profile_sync: checkpoint,
      reconciliation_required: false,
      observed: {
        nickname: member?.nickname ?? null,
        managed_role_ids: managedRoleIds.filter((roleId) => current.has(roleId)),
      },
    },
  };
};

const runtimeContextValues = (runtime) => {
  const sources = [
    runtime?.connectionContext,
    runtime?.connection,
    runtime?.installationContext,
    runtime?.installation,
    runtime?.context,
    runtime?.client?.connectionContext,
    runtime?.client?.connection,
  ].filter(isObject);
  const expanded = [...sources];
  for (const source of sources) {
    for (const key of ['installation', 'connection', 'context']) {
      if (isObject(source[key])) expanded.push(source[key]);
    }
  }
  const first = (keys) => {
    for (const source of expanded) {
      for (const key of keys) {
        if (source[key] !== undefined && source[key] !== null) return source[key];
      }
    }
    return undefined;
  };
  return {
    applicationId: runtime?.applicationId
      ?? runtime?.discordApplicationId
      ?? runtime?.client?.applicationId
      ?? runtime?.client?.application?.id
      ?? first(['application_id', 'applicationId', 'discord_application_id', 'discordApplicationId']),
    connectionId: runtime?.connectionId
      ?? runtime?.nexusConnectionId
      ?? first(['connection_id', 'connectionId', 'nexus_connection_id', 'nexusConnectionId']),
    generation: runtime?.generation
      ?? runtime?.connectionGeneration
      ?? first(['generation', 'connection_generation', 'connectionGeneration']),
  };
};

const validateRuntimeContext = (command, runtime, payload) => {
  const expectedGuildId = payload.installation.guild_id.trim();
  if (`${runtime?.guildId ?? ''}`.trim() !== expectedGuildId) return failure('wrong_guild');
  if (command?.guild_id !== undefined && command.guild_id !== null
    && `${command.guild_id}`.trim() !== expectedGuildId) {
    return failure('wrong_guild');
  }

  const observed = runtimeContextValues(runtime);
  if (observed.applicationId === undefined
    || `${observed.applicationId}`.trim() !== payload.installation.application_id.trim()) {
    return failure('wrong_application');
  }
  if (observed.connectionId === undefined
    || `${observed.connectionId}`.trim() !== payload.installation.connection_id.trim()) {
    return failure('wrong_connection');
  }
  if (observed.generation === undefined || observed.generation !== payload.installation.generation) {
    return failure('stale_connection_generation');
  }
  return null;
};

const checkpointArray = (value) => {
  if (!Array.isArray(value) || value.length > 100) return null;
  const normalized = value.map(normalizeSnowflake);
  if (normalized.some((item) => item === null) || new Set(normalized).size !== normalized.length) return null;
  return normalized;
};

const normalizeCheckpoint = (raw, payload) => {
  if (raw === undefined) {
    return {
      valid: true,
      value: {
        profile_revision: payload.member.profile_revision,
        nickname_applied: false,
        roles_added: [],
        roles_removed: [],
      },
    };
  }
  if (!hasOnlyKeys(raw, CHECKPOINT_KEYS)
    || raw.profile_revision !== payload.member.profile_revision
    || typeof raw.nickname_applied !== 'boolean') {
    return invalid('invalid_checkpoint');
  }
  const rolesAdded = checkpointArray(raw.roles_added);
  const rolesRemoved = checkpointArray(raw.roles_removed);
  if (!rolesAdded || !rolesRemoved) return invalid('invalid_checkpoint');
  const expectedAdds = new Set(payload.desired.roles.add.map((roleId) => roleId.trim()));
  const expectedRemoves = new Set(payload.desired.roles.remove.map((roleId) => roleId.trim()));
  if (rolesAdded.some((roleId) => !expectedAdds.has(roleId))
    || rolesRemoved.some((roleId) => !expectedRemoves.has(roleId))) {
    return invalid('invalid_checkpoint');
  }
  return {
    valid: true,
    value: {
      profile_revision: raw.profile_revision,
      nickname_applied: raw.nickname_applied,
      roles_added: rolesAdded,
      roles_removed: rolesRemoved,
    },
  };
};

const checkpointAvailable = (command, runtime) => typeof runtime?.apiService?.checkpointDiscordQueue === 'function'
  && command?.id !== undefined
  && command?.id !== null
  && typeof command?.lease_token === 'string'
  && command.lease_token.length > 0;

const copyCheckpoint = (value) => ({
  profile_revision: value.profile_revision,
  nickname_applied: value.nickname_applied,
  roles_added: [...value.roles_added],
  roles_removed: [...value.roles_removed],
});

const hasAppliedMutation = (checkpoint) => checkpoint.nickname_applied
  || checkpoint.roles_added.length > 0
  || checkpoint.roles_removed.length > 0;

const saveCheckpoint = async (command, runtime, accumulated, afterMutation = false) => {
  if (!checkpointAvailable(command, runtime)) {
    return failure('checkpoint_unavailable', {
      reconciliationRequired: afterMutation,
      checkpoint: accumulated,
    });
  }
  try {
    const response = await runtime.apiService.checkpointDiscordQueue(
      command.id,
      command.lease_token,
      { member_profile_sync: copyCheckpoint(accumulated) },
    );
    if (response === false || response?.success === false) throw new Error('checkpoint rejected');
    return null;
  } catch {
    return failure('checkpoint_failed', {
      reconciliationRequired: afterMutation,
      checkpoint: accumulated,
    });
  }
};

const errorCode = (error) => error?.code ?? error?.status ?? error?.response?.status ?? null;
const classifyError = (error, fallbackReason) => {
  const code = errorCode(error);
  if (PERMISSION_ERROR_CODES.has(Number(code))) {
    return { reason: 'missing_discord_permission', retryable: false };
  }
  if (Number(code) === 10007) return { reason: 'member_unavailable', retryable: false };
  if (Number(code) === 10011) return { reason: 'role_not_found', retryable: false };
  if (Number(code) === 429 || Number(error?.status) >= 500 || NETWORK_ERROR_CODES.has(`${code}`)) {
    return { reason: fallbackReason, retryable: true };
  }
  return { reason: fallbackReason, retryable: true };
};

const collectionGet = (collection, key) => {
  if (typeof collection?.get === 'function') return collection.get(key);
  return collection?.[key];
};

const collectionValues = (collection) => {
  if (typeof collection?.values === 'function') return Array.from(collection.values());
  if (Array.isArray(collection)) return collection;
  return isObject(collection) ? Object.values(collection) : [];
};

const resolveRole = async (guild, roleId) => {
  const cached = collectionGet(guild?.roles?.cache, roleId);
  if (cached !== undefined) return cached;
  if (typeof guild?.roles?.fetch !== 'function') return null;
  return guild.roles.fetch(roleId);
};

const roleIsEditable = (role, guildId) => role
  && normalizeSnowflake(role.id) !== null
  && role.id !== guildId
  && role.managed !== true
  && role.editable !== false
  && role.manageable !== false
  && (!role.guildId && !role.guild?.id || `${role.guildId ?? role.guild?.id}` === guildId);

const memberRoleIds = (member) => new Set(
  collectionValues(member?.roles?.cache).map((role) => `${role?.id ?? ''}`).filter(Boolean),
);

const mutate = async (runtime, operation, label, fallbackReason) => {
  try {
    await runtime.withDiscordRetry(operation, label);
    return null;
  } catch (error) {
    return classifyError(error, fallbackReason);
  }
};

export const execute = async (command, runtime) => {
  const payload = command?.payload;
  const validation = validate(payload);
  if (!validation.valid) return failure(validation.reason);
  const contextFailure = validateRuntimeContext(command, runtime, payload);
  if (contextFailure) return contextFailure;
  if (!runtime.canContinue()) return failure('lease_lost', { retryable: true });

  const checkpointResult = normalizeCheckpoint(command?.result?.member_profile_sync, payload);
  if (!checkpointResult.valid) return failure(checkpointResult.reason);
  const accumulated = checkpointResult.value;
  const preflightCheckpoint = await saveCheckpoint(command, runtime, accumulated);
  if (preflightCheckpoint) return preflightCheckpoint;

  let guild;
  try {
    guild = await runtime.resolveGuild();
  } catch (error) {
    const classified = classifyError(error, 'guild_unavailable');
    return failure(classified.reason, { retryable: classified.retryable });
  }
  if (!guild || `${guild.id ?? ''}`.trim() !== payload.installation.guild_id.trim()) {
    return failure('guild_unavailable', { retryable: true });
  }

  let member;
  try {
    member = await guild.members.fetch(payload.member.discord_user_id.trim());
  } catch (error) {
    const classified = classifyError(error, 'member_unavailable');
    return failure(classified.reason, { retryable: classified.retryable });
  }
  if (!member || `${member.id ?? ''}`.trim() !== payload.member.discord_user_id.trim()) {
    return failure('member_unavailable');
  }
  const memberGuildId = `${member.guildId ?? member.guild?.id ?? ''}`.trim();
  if (memberGuildId && memberGuildId !== guild.id) return failure('wrong_guild_member');

  const managedRoleIds = payload.desired.roles.managed.map((roleId) => roleId.trim());
  const requestedAdds = payload.desired.roles.add.map((roleId) => roleId.trim());
  const requestedRemoves = payload.desired.roles.remove.map((roleId) => roleId.trim());
  const current = memberRoleIds(member);
  const adds = requestedAdds.filter((roleId) => !current.has(roleId));
  const removes = requestedRemoves.filter((roleId) => current.has(roleId));
  const nicknameChanged = member.nickname !== payload.desired.nickname;
  if ((nicknameChanged || adds.length > 0 || removes.length > 0) && member.manageable === false) {
    return failure('member_unmanageable');
  }

  for (const roleId of [...adds, ...removes]) {
    let role;
    try {
      role = await resolveRole(guild, roleId);
    } catch (error) {
      const classified = classifyError(error, 'role_fetch_failed');
      return failure(classified.reason, { retryable: classified.retryable });
    }
    if (!role) return failure('role_not_found');
    if (!roleIsEditable(role, guild.id)) return failure('role_unmanageable');
  }

  if (nicknameChanged) {
    if (!runtime.canContinue()) {
      return failure('lease_lost', {
        retryable: true,
        reconciliationRequired: hasAppliedMutation(accumulated),
        checkpoint: accumulated,
      });
    }
    if (typeof member.setNickname !== 'function') return failure('nickname_update_unavailable');
    const failed = await mutate(
      runtime,
      () => member.setNickname(payload.desired.nickname, 'Nexus AMS member profile synchronization'),
      'update MEMBER_PROFILE_SYNC nickname',
      'nickname_update_failed',
    );
    if (failed) {
      return failure(failed.reason, {
        retryable: failed.retryable,
        reconciliationRequired: true,
        checkpoint: accumulated,
      });
    }
    member.nickname = payload.desired.nickname;
    accumulated.nickname_applied = true;
    const saved = await saveCheckpoint(command, runtime, accumulated, true);
    if (saved) return saved;
  } else if (!nicknameChanged) {
    accumulated.nickname_applied = true;
  }

  const completedAdds = new Set(accumulated.roles_added);
  const pendingAdds = adds;
  if (pendingAdds.length > 0) {
    if (!runtime.canContinue()) {
      return failure('lease_lost', {
        retryable: true,
        reconciliationRequired: hasAppliedMutation(accumulated),
        checkpoint: accumulated,
      });
    }
    const failed = await mutate(
      runtime,
      () => member.roles.add(pendingAdds, 'Nexus AMS member profile synchronization'),
      'add MEMBER_PROFILE_SYNC roles',
      'role_add_failed',
    );
    if (failed) {
      return failure(failed.reason, {
        retryable: failed.retryable,
        reconciliationRequired: true,
        checkpoint: accumulated,
      });
    }
    accumulated.roles_added = [...new Set([...completedAdds, ...pendingAdds])];
    for (const roleId of pendingAdds) current.add(roleId);
    const saved = await saveCheckpoint(command, runtime, accumulated, true);
    if (saved) return saved;
  }

  const completedRemoves = new Set(accumulated.roles_removed);
  const pendingRemoves = removes;
  if (pendingRemoves.length > 0) {
    if (!runtime.canContinue()) {
      return failure('lease_lost', {
        retryable: true,
        reconciliationRequired: hasAppliedMutation(accumulated),
        checkpoint: accumulated,
      });
    }
    const failed = await mutate(
      runtime,
      () => member.roles.remove(pendingRemoves, 'Nexus AMS member profile synchronization'),
      'remove MEMBER_PROFILE_SYNC roles',
      'role_remove_failed',
    );
    if (failed) {
      return failure(failed.reason, {
        retryable: failed.retryable,
        reconciliationRequired: true,
        checkpoint: accumulated,
      });
    }
    accumulated.roles_removed = [...new Set([...completedRemoves, ...pendingRemoves])];
    for (const roleId of pendingRemoves) current.delete(roleId);
    const saved = await saveCheckpoint(command, runtime, accumulated, true);
    if (saved) return saved;
  }

  if (!runtime.canContinue()) {
    return failure('lease_lost', {
      retryable: true,
      reconciliationRequired: true,
      checkpoint: accumulated,
    });
  }
  let refreshed;
  try {
    refreshed = await guild.members.fetch(payload.member.discord_user_id.trim());
  } catch (error) {
    const classified = classifyError(error, 'member_refresh_failed');
    return failure(classified.reason, {
      retryable: classified.retryable,
      reconciliationRequired: hasAppliedMutation(accumulated),
      checkpoint: accumulated,
    });
  }
  if (!refreshed || `${refreshed.id ?? ''}`.trim() !== payload.member.discord_user_id.trim()) {
    return failure('member_unavailable', { retryable: true, checkpoint: accumulated });
  }
  const finalRoles = memberRoleIds(refreshed);
  if (refreshed.nickname !== payload.desired.nickname
    || requestedAdds.some((roleId) => !finalRoles.has(roleId))
    || requestedRemoves.some((roleId) => finalRoles.has(roleId))) {
    return failure('profile_state_drift', {
      retryable: true,
      reconciliationRequired: true,
      checkpoint: accumulated,
    });
  }
  return success(accumulated, refreshed, managedRoleIds);
};
