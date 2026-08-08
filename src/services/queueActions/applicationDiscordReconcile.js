import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { isDiscordSnowflake, isUuid } from '../../utils/boundaryValidators.js';
import {
  buildApplicationChannelTopic,
  validateApplicationInterviewChannel,
} from '../../utils/applicationChannels.js';

const TOP_LEVEL_KEYS = ['contract_version', 'installation', 'application', 'desired'];
const INSTALLATION_KEYS = ['application_id', 'guild_id', 'connection_id', 'generation'];
const APPLICATION_KEYS = ['id', 'state', 'discord_user_id', 'nation_id', 'revision'];
const DESIRED_KEYS = ['channel', 'roles', 'notifications'];
const CHANNEL_KEYS = [
  'mode',
  'channel_id',
  'category_id',
  'name',
  'topic',
  'staff_role_ids',
  'intro_messages',
];
const ROLE_KEYS = ['add', 'remove'];
const INTRO_KEYS = ['key', 'content'];
const NOTIFICATION_KEYS = ['key', 'destination', 'content'];
const CHANNEL_DESTINATION_KEYS = ['type', 'channel_id'];
const DM_DESTINATION_KEYS = ['type', 'discord_user_id'];
const CHECKPOINT_KEYS = [
  'application_revision',
  'channel_id',
  'channel_deleted',
  'roles_added',
  'roles_removed',
  'intro_messages',
  'notifications',
];
const APPLICATION_STATES = new Set(['pending', 'approved', 'denied', 'cancelled']);
const CHANNEL_MODES = new Set(['ensure', 'absent', 'unchanged']);
const SAFE_DOTTED_IDENTIFIER = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/;
const UNSAFE_MENTION = /@(?:everyone|here)\b|<@!?\d{17,20}>|<@&\d{17,20}>|<#\d{17,20}>|<a?:[a-z0-9_~-]+:\d{17,20}>/i;
const ASSIGNMENT_TERMINOLOGY = /\bassign\w*\b/i;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const NETWORK_ERROR_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);
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

const normalizeSnowflake = (value) => (isDiscordSnowflake(value) ? value.trim() : null);

const hasUnsafeText = (value) => UNSAFE_MENTION.test(value) || ASSIGNMENT_TERMINOLOGY.test(value);

const isSafeText = (value, { min = 0, max, allowNewlines = true } = {}) => {
  if (typeof value !== 'string' || value.length < min || value.length > max) return false;
  if (CONTROL_CHARACTERS.test(value)) return false;
  if (!allowNewlines && /[\r\n\t]/.test(value)) return false;
  return !hasUnsafeText(value);
};

const isSafeIdentifier = (value) => typeof value === 'string'
  && value.length <= 64
  && SAFE_DOTTED_IDENTIFIER.test(value)
  && !hasUnsafeText(value);

const validateUniqueSnowflakes = (value, max, reason) => {
  if (!Array.isArray(value) || value.length > max) return invalid(reason);
  const normalized = value.map(normalizeSnowflake);
  if (normalized.some((item) => item === null)) return invalid(reason);
  if (new Set(normalized).size !== normalized.length) return invalid(reason);
  return valid();
};

const validateMessage = (value, reason) => {
  if (!hasOnlyKeys(value, INTRO_KEYS)) return invalid(reason);
  if (!isSafeIdentifier(value.key) || !isSafeText(value.content, { min: 1, max: 2000 })) {
    return invalid(reason);
  }
  return valid();
};

const validateDestination = (value) => {
  if (!isObject(value) || typeof value.type !== 'string') return invalid('invalid_notification_destination');

  if (value.type === 'channel') {
    if (!hasOnlyKeys(value, ['type', 'channel_id']) || !isDiscordSnowflake(value.channel_id)) {
      return invalid('invalid_notification_destination');
    }
    return valid();
  }

  if (value.type === 'dm') {
    if (!hasOnlyKeys(value, ['type', 'discord_user_id']) || !isDiscordSnowflake(value.discord_user_id)) {
      return invalid('invalid_notification_destination');
    }
    return valid();
  }

  return invalid('invalid_notification_destination');
};

const validateChannel = (channel) => {
  if (!hasOnlyKeys(channel, ['mode'], CHANNEL_KEYS.slice(1))) return invalid('invalid_channel');
  if (!CHANNEL_MODES.has(channel.mode)) return invalid('invalid_channel_mode');

  for (const key of ['channel_id', 'category_id']) {
    if (Object.hasOwn(channel, key) && !isDiscordSnowflake(channel[key])) {
      return invalid(`invalid_${key}`);
    }
  }
  if (Object.hasOwn(channel, 'name')
    && !isSafeText(channel.name, { min: 1, max: 100, allowNewlines: false })) {
    return invalid('invalid_channel_name');
  }
  if (Object.hasOwn(channel, 'topic') && !isSafeText(channel.topic, { max: 1024 })) {
    return invalid('invalid_channel_topic');
  }
  if (Object.hasOwn(channel, 'staff_role_ids')) {
    const result = validateUniqueSnowflakes(channel.staff_role_ids, 10, 'invalid_staff_role_ids');
    if (!result.valid) return result;
  }
  if (Object.hasOwn(channel, 'intro_messages')) {
    if (!Array.isArray(channel.intro_messages) || channel.intro_messages.length > 5) {
      return invalid('invalid_intro_messages');
    }
    const keys = new Set();
    for (const message of channel.intro_messages) {
      const result = validateMessage(message, 'invalid_intro_message');
      if (!result.valid) return result;
      if (keys.has(message.key)) return invalid('duplicate_intro_message');
      keys.add(message.key);
    }
  }
  if (channel.mode === 'absent' && (channel.intro_messages?.length ?? 0) > 0) {
    return invalid('invalid_intro_messages_for_absent_channel');
  }
  return valid();
};

const validateRoles = (roles) => {
  if (!hasOnlyKeys(roles, ROLE_KEYS)) return invalid('invalid_roles');
  const add = validateUniqueSnowflakes(roles.add, 10, 'invalid_role_additions');
  if (!add.valid) return add;
  const remove = validateUniqueSnowflakes(roles.remove, 10, 'invalid_role_removals');
  if (!remove.valid) return remove;
  const additions = new Set(roles.add.map((roleId) => roleId.trim()));
  if (roles.remove.some((roleId) => additions.has(roleId.trim()))) {
    return invalid('overlapping_role_changes');
  }
  return valid();
};

const validateNotifications = (notifications) => {
  if (!Array.isArray(notifications) || notifications.length > 5) {
    return invalid('invalid_notifications');
  }
  const keys = new Set();
  for (const notification of notifications) {
    if (!hasOnlyKeys(notification, NOTIFICATION_KEYS)
      || !isSafeIdentifier(notification.key)
      || !isSafeText(notification.content, { min: 1, max: 2000 })) {
      return invalid('invalid_notification');
    }
    if (keys.has(notification.key)) return invalid('duplicate_notification');
    keys.add(notification.key);
    const destination = validateDestination(notification.destination);
    if (!destination.valid) return destination;
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

  if (!hasOnlyKeys(payload.application, APPLICATION_KEYS)
    || !isPositiveInteger(payload.application.id)
    || !APPLICATION_STATES.has(payload.application.state)
    || !isDiscordSnowflake(payload.application.discord_user_id)
    || !isPositiveInteger(payload.application.nation_id)
    || !isPositiveInteger(payload.application.revision)) {
    return invalid('invalid_application');
  }

  if (!hasOnlyKeys(payload.desired, DESIRED_KEYS)) return invalid('invalid_desired');
  const channel = validateChannel(payload.desired.channel);
  if (!channel.valid) return channel;
  const roles = validateRoles(payload.desired.roles);
  if (!roles.valid) return roles;
  const notifications = validateNotifications(payload.desired.notifications);
  if (!notifications.valid) return notifications;
  return valid();
};

const loggerCall = (runtime, level, message, context = {}) => {
  runtime?.logger?.[level]?.(message, context);
};

const canContinue = (runtime) => typeof runtime?.canContinue !== 'function' || runtime.canContinue();

const checkpointAvailable = (command, runtime) => typeof runtime?.apiService?.checkpointDiscordQueue === 'function'
  && command?.id !== undefined
  && command?.id !== null
  && typeof command?.lease_token === 'string'
  && command.lease_token.length > 0;

const copyCheckpoint = (value) => ({
  application_revision: value.application_revision,
  channel_id: value.channel_id,
  channel_deleted: value.channel_deleted,
  roles_added: [...value.roles_added],
  roles_removed: [...value.roles_removed],
  intro_messages: [...value.intro_messages],
  notifications: [...value.notifications],
});

const failure = (reason, {
  retryable = false,
  reconciliationRequired = false,
  checkpoint = null,
} = {}) => {
  const response = {
    success: false,
    reason,
    retryable,
  };
  if (reconciliationRequired || checkpoint) {
    response.reconciliation_required = reconciliationRequired;
  }
  if (checkpoint) {
    response.result = {
      application_reconcile: checkpoint,
      reconciliation_required: reconciliationRequired,
    };
  }
  return response;
};

const success = (checkpoint) => ({
  success: true,
  result: {
    application_reconcile: checkpoint,
    reconciliation_required: false,
  },
});

const errorCode = (error) => error?.code ?? error?.status ?? error?.response?.status ?? null;

const isUnknownChannel = (error) => errorCode(error) === 10003
  || /unknown channel/i.test(`${error?.message ?? ''}`);

const classifyError = (error, fallbackReason) => {
  const code = errorCode(error);
  if (code === 50007) return { reason: 'dm_closed', retryable: false };
  if (PERMISSION_ERROR_CODES.has(Number(code))) return { reason: 'missing_discord_permission', retryable: false };
  if (Number(code) === 10003) return { reason: 'unknown_channel', retryable: false };
  if (Number(code) === 429 || Number(error?.status) >= 500 || NETWORK_ERROR_CODES.has(`${code}`)) {
    return { reason: fallbackReason, retryable: true };
  }
  return { reason: fallbackReason, retryable: true };
};

const checkpoint = async (command, runtime, accumulated, { afterMutation = false } = {}) => {
  if (!checkpointAvailable(command, runtime)) {
    loggerCall(runtime, 'error', 'APPLICATION_DISCORD_RECONCILE lacks a durable checkpoint target', {
      commandId: command?.id ?? null,
      reconciliationRequired: afterMutation,
    });
    return failure('checkpoint_unavailable', {
      retryable: false,
      reconciliationRequired: afterMutation,
      checkpoint: accumulated,
    });
  }

  try {
    const response = await runtime.apiService.checkpointDiscordQueue(
      command.id,
      command.lease_token,
      { application_reconcile: copyCheckpoint(accumulated) },
    );
    if (response === false || response?.success === false) {
      throw new Error('Nexus rejected the Discord reconciliation checkpoint.');
    }
    return null;
  } catch (error) {
    loggerCall(runtime, 'error', 'APPLICATION_DISCORD_RECONCILE checkpoint failed', {
      commandId: command?.id ?? null,
      reconciliationRequired: afterMutation,
      status: errorCode(error),
    });
    return failure('checkpoint_failed', {
      retryable: false,
      reconciliationRequired: afterMutation,
      checkpoint: accumulated,
    });
  }
};

const checkpointArray = (value, validator) => {
  if (!Array.isArray(value)) return null;
  const normalized = value.map((item) => (typeof item === 'string' ? item.trim() : item));
  if (normalized.some((item) => !validator(item)) || new Set(normalized).size !== normalized.length) return null;
  return normalized;
};

const readCheckpointArray = (source, key, validator) => (
  Object.hasOwn(source, key) ? checkpointArray(source[key], validator) : []
);

const normalizeCheckpoint = (raw, payload) => {
  if (raw !== undefined && (!isObject(raw) || !hasOnlyKeys(raw, [], CHECKPOINT_KEYS))) {
    return invalid('invalid_checkpoint');
  }
  const source = raw ?? {};
  if (raw !== undefined
    && (!Object.hasOwn(source, 'application_revision')
      || !isPositiveInteger(source.application_revision))) {
    return invalid('invalid_checkpoint');
  }
  if (raw !== undefined && source.application_revision !== payload.application.revision) {
    return invalid('checkpoint_revision_mismatch');
  }
  const rawChannelId = Object.hasOwn(source, 'channel_id') ? source.channel_id : null;
  if (rawChannelId !== null && !isDiscordSnowflake(rawChannelId)) return invalid('invalid_checkpoint');
  if (Object.hasOwn(source, 'channel_deleted') && typeof source.channel_deleted !== 'boolean') {
    return invalid('invalid_checkpoint');
  }

  const rolesAdded = readCheckpointArray(source, 'roles_added', isDiscordSnowflake);
  const rolesRemoved = readCheckpointArray(source, 'roles_removed', isDiscordSnowflake);
  const introMessages = readCheckpointArray(source, 'intro_messages', isSafeIdentifier);
  const notifications = readCheckpointArray(source, 'notifications', isSafeIdentifier);
  if (!rolesAdded || !rolesRemoved || !introMessages || !notifications) return invalid('invalid_checkpoint');

  const checkpointValue = {
    application_revision: payload.application.revision,
    channel_id: rawChannelId === null ? null : rawChannelId.trim(),
    channel_deleted: source.channel_deleted === true,
    roles_added: rolesAdded,
    roles_removed: rolesRemoved,
    intro_messages: introMessages,
    notifications,
  };
  if (checkpointValue.channel_deleted && checkpointValue.channel_id !== null) {
    return invalid('invalid_checkpoint');
  }
  if (payload.desired.channel.mode === 'ensure' && checkpointValue.channel_deleted) {
    return invalid('invalid_checkpoint');
  }

  const desiredChannelId = payload.desired.channel.channel_id?.trim() ?? null;
  if (checkpointValue.channel_id && desiredChannelId && checkpointValue.channel_id !== desiredChannelId) {
    return invalid('checkpoint_channel_mismatch');
  }

  const desiredAdds = new Set(payload.desired.roles.add.map((roleId) => roleId.trim()));
  const desiredRemoves = new Set(payload.desired.roles.remove.map((roleId) => roleId.trim()));
  if (rolesAdded.some((roleId) => !desiredAdds.has(roleId))
    || rolesRemoved.some((roleId) => !desiredRemoves.has(roleId))
    || rolesAdded.some((roleId) => desiredRemoves.has(roleId))
    || rolesRemoved.some((roleId) => desiredAdds.has(roleId))) {
    return invalid('invalid_checkpoint');
  }

  const desiredIntroKeys = new Set((payload.desired.channel.intro_messages ?? []).map(({ key }) => key));
  const desiredNotificationKeys = new Set(payload.desired.notifications.map(({ key }) => key));
  if (introMessages.some((key) => !desiredIntroKeys.has(key))
    || notifications.some((key) => !desiredNotificationKeys.has(key))) {
    return invalid('invalid_checkpoint');
  }
  return { valid: true, value: checkpointValue };
};

const collectionGet = (collection, id) => {
  if (!collection) return undefined;
  if (typeof collection.get === 'function') return collection.get(id);
  if (Object.hasOwn(collection, id)) return collection[id];
  return undefined;
};

const collectionValues = (collection) => {
  if (!collection) return [];
  if (typeof collection.values === 'function') return Array.from(collection.values());
  if (Array.isArray(collection)) return collection;
  if (typeof collection === 'object') return Object.values(collection);
  return [];
};

const channelGuildId = (channel) => `${channel?.guildId ?? channel?.guild?.id ?? ''}`.trim();

const listGuildChannels = async (guild) => {
  if (typeof guild?.channels?.fetch !== 'function') {
    return { channels: null, error: new Error('Guild channel collection listing is unavailable.') };
  }
  try {
    const collection = await guild.channels.fetch();
    if (!collection || (!Array.isArray(collection)
      && typeof collection.values !== 'function'
      && typeof collection !== 'object')) {
      return { channels: null, error: new Error('Guild channel collection listing returned an invalid result.') };
    }
    return { channels: collectionValues(collection), error: null };
  } catch (error) {
    return { channels: null, error };
  }
};

const exactTopicCandidates = (channels, topic, guildId) => {
  const exactMatches = channels.filter((channel) => channel?.topic === topic);
  if (exactMatches.some((channel) => !normalizeSnowflake(channel?.id))) {
    return { failure: failure('invalid_channel') };
  }
  if (exactMatches.some((channel) => !guildScopedChannel(channel, guildId))) {
    return { failure: failure('wrong_guild_channel') };
  }
  const candidates = exactMatches.filter((channel) => guildScopedChannel(channel, guildId));
  if (candidates.length > 1) return { failure: failure('duplicate_channel_topic') };
  return { candidates };
};

const resolveGuildChannel = async (guild, runtime, channelId) => {
  const cached = collectionGet(guild?.channels?.cache, channelId);
  if (cached !== undefined) return { channel: cached, error: null, unknown: cached === null };

  if (typeof guild?.channels?.fetch === 'function') {
    try {
      const fetched = await guild.channels.fetch(channelId);
      return { channel: fetched ?? null, error: null, unknown: !fetched };
    } catch (error) {
      return { channel: null, error, unknown: isUnknownChannel(error) };
    }
  }

  if (typeof runtime?.resolveChannelWithError === 'function') {
    const result = await runtime.resolveChannelWithError(channelId);
    return {
      channel: result?.value ?? null,
      error: result?.error ?? null,
      unknown: !result?.value && !result?.error,
    };
  }
  if (typeof runtime?.resolveChannel === 'function') {
    const channel = await runtime.resolveChannel(channelId);
    return { channel: channel ?? null, error: null, unknown: !channel };
  }
  if (typeof runtime?.resolveTextChannel === 'function') {
    const channel = await runtime.resolveTextChannel(channelId);
    return { channel: channel ?? null, error: null, unknown: !channel };
  }
  return { channel: null, error: null, unknown: true };
};

const guildScopedChannel = (channel, guildId) => {
  if (!channel) return false;
  const actualGuildId = channelGuildId(channel);
  return actualGuildId !== '' && actualGuildId !== '0' && actualGuildId === guildId;
};

const interviewValidation = (channel, payload, guildId, fallbackTopic = undefined) => {
  const candidate = {
    ...channel,
    type: channel.type ?? ChannelType.GuildText,
    ...(channel.topic === undefined && fallbackTopic !== undefined ? { topic: fallbackTopic } : {}),
  };
  const result = validateApplicationInterviewChannel({
    channel: candidate,
    application: payload.application,
    guildId,
  });
  if (!result.valid) return result;
  if (payload.desired.channel.topic !== undefined && candidate.topic !== payload.desired.channel.topic) {
    return { valid: false, reason: 'channel_topic_mismatch' };
  }
  return result;
};

const withDiscordRetry = (runtime, operation, label) => {
  if (typeof runtime?.withDiscordRetry === 'function') return runtime.withDiscordRetry(operation, label);
  return operation();
};

const createPermissionOverwrites = (guild, payload) => {
  const everyoneId = guild?.roles?.everyone?.id ?? guild.id;
  const grantPermissions = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.AttachFiles,
  ];
  const botPermissions = [
    ...grantPermissions,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.EmbedLinks,
  ];
  const grants = new Map();
  grants.set(payload.application.discord_user_id.trim(), new Set(grantPermissions));
  for (const roleId of payload.desired.channel.staff_role_ids ?? []) {
    const normalizedRoleId = roleId.trim();
    if (normalizedRoleId === everyoneId) continue;
    const existing = grants.get(normalizedRoleId) ?? new Set();
    grantPermissions.forEach((permission) => existing.add(permission));
    grants.set(normalizedRoleId, existing);
  }
  const botId = payload.installation.application_id.trim();
  if (botId !== everyoneId) {
    const existing = grants.get(botId) ?? new Set();
    botPermissions.forEach((permission) => existing.add(permission));
    grants.set(botId, existing);
  }
  return [
    { id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] },
    ...Array.from(grants, ([id, allow]) => ({ id, allow: Array.from(allow) })),
  ];
};

const ensureChannel = async (command, runtime, guild, payload, accumulated) => {
  const desiredChannel = payload.desired.channel;
  const authoritativeId = accumulated.channel_id ?? desiredChannel.channel_id?.trim() ?? null;

  if (authoritativeId) {
    const resolved = await resolveGuildChannel(guild, runtime, authoritativeId);
    if (resolved.channel) {
      if (!guildScopedChannel(resolved.channel, guild.id)) {
        return { failure: failure('wrong_guild_channel') };
      }
      const validation = interviewValidation(resolved.channel, payload, guild.id);
      if (!validation.valid) return { failure: failure(validation.reason) };
      return { channel: resolved.channel };
    }
    if (resolved.error && !resolved.unknown) {
      const classified = classifyError(resolved.error, 'channel_fetch_failed');
      return { failure: failure(classified.reason, { retryable: classified.retryable }) };
    }
  }

  const expectedTopic = desiredChannel.topic ?? buildApplicationChannelTopic(
    payload.application.id,
    payload.application.nation_id,
  );
  if (!expectedTopic) return { failure: failure('invalid_channel_topic') };

  const listed = await listGuildChannels(guild);
  if (listed.error) {
    const classified = classifyError(listed.error, 'channel_collection_unavailable');
    return { failure: failure(classified.reason, { retryable: classified.retryable }) };
  }
  const topicMatches = exactTopicCandidates(listed.channels, expectedTopic, guild.id);
  if (topicMatches.failure) return topicMatches;
  if (topicMatches.candidates.length === 1) {
    const validation = interviewValidation(topicMatches.candidates[0], payload, guild.id);
    if (!validation.valid) return { failure: failure(validation.reason) };
    accumulated.channel_id = topicMatches.candidates[0].id.trim();
    return { channel: topicMatches.candidates[0] };
  }

  if (!checkpointAvailable(command, runtime)) {
    return { failure: failure('checkpoint_unavailable') };
  }
  if (!canContinue(runtime)) return { failure: failure('lease_lost', { retryable: true }) };
  if (typeof guild?.channels?.create !== 'function') {
    return { failure: failure('channel_creation_unavailable', { retryable: true }) };
  }

  const topic = expectedTopic;
  const name = desiredChannel.name ?? `nexus-application-${payload.application.id}-${payload.application.nation_id}`;
  const options = {
    name,
    topic,
    type: ChannelType.GuildText,
    permissionOverwrites: createPermissionOverwrites(guild, payload),
    reason: 'Nexus AMS application Discord reconciliation',
  };
  if (desiredChannel.category_id) options.parent = desiredChannel.category_id.trim();

  let channel;
  try {
    channel = await withDiscordRetry(runtime, () => guild.channels.create(options), 'create application interview channel');
  } catch (error) {
    const classified = classifyError(error, 'channel_creation_failed');
    return { failure: failure(classified.reason, { retryable: classified.retryable }) };
  }
  const createdId = normalizeSnowflake(channel?.id);
  if (!createdId) {
    return {
      failure: failure('invalid_created_channel', {
        reconciliationRequired: true,
        checkpoint: { ...accumulated },
      }),
    };
  }
  accumulated.channel_id = createdId;
  const saved = await checkpoint(command, runtime, accumulated, { afterMutation: true });
  if (saved) return { failure: saved };

  const validation = interviewValidation(channel, payload, guild.id, topic);
  if (!validation.valid) {
    return {
      failure: failure('created_channel_validation_failed', {
        reconciliationRequired: true,
        checkpoint: accumulated,
      }),
    };
  }
  return { channel };
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

const memberRoleIds = (member) => {
  const cache = member?.roles?.cache;
  return new Set(collectionValues(cache).map((role) => `${role?.id ?? ''}`).filter(Boolean));
};

const syncRoles = async (command, runtime, guild, payload, accumulated) => {
  const desiredAdds = payload.desired.roles.add.map((roleId) => roleId.trim());
  const desiredRemoves = payload.desired.roles.remove.map((roleId) => roleId.trim());
  if (desiredAdds.length === 0 && desiredRemoves.length === 0) return null;

  let member;
  try {
    member = await guild.members.fetch(payload.application.discord_user_id.trim());
  } catch (error) {
    const classified = classifyError(error, 'member_unavailable');
    return failure(classified.reason === 'missing_discord_permission' ? classified.reason : 'member_unavailable', {
      retryable: classified.retryable,
    });
  }
  if (!member) return failure('member_unavailable', { retryable: true });
  if (member.id !== undefined && `${member.id}`.trim() !== payload.application.discord_user_id.trim()) {
    return failure('wrong_member');
  }
  const memberGuildId = `${member.guildId ?? member.guild?.id ?? ''}`.trim();
  if (memberGuildId && memberGuildId !== guild.id) return failure('wrong_guild_member');

  const roleIds = [...desiredAdds, ...desiredRemoves];
  const roles = new Map();
  for (const roleId of roleIds) {
    let role;
    try {
      role = await resolveRole(guild, roleId);
    } catch (error) {
      const classified = classifyError(error, 'role_fetch_failed');
      return failure(classified.reason === 'missing_discord_permission' ? classified.reason : 'role_fetch_failed', {
        retryable: classified.retryable,
      });
    }
    if (!role) return failure('role_not_found');
    if (!roleIsEditable(role, guild.id)) return failure('role_unmanageable');
    roles.set(roleId, role);
  }

  const current = memberRoleIds(member);
  if (member.manageable === false) {
    const needsMutation = desiredAdds.some((roleId) => !current.has(roleId))
      || desiredRemoves.some((roleId) => current.has(roleId));
    if (needsMutation) return failure('member_unmanageable');
  }

  const completedAdds = new Set(accumulated.roles_added);
  const completedRemoves = new Set(accumulated.roles_removed);

  for (const roleId of desiredAdds) {
    if (completedAdds.has(roleId)) {
      if (!current.has(roleId)) return failure('role_state_drift', { retryable: true, checkpoint: accumulated });
      continue;
    }
    if (current.has(roleId)) {
      completedAdds.add(roleId);
      accumulated.roles_added = [...completedAdds];
      continue;
    }
    if (!canContinue(runtime)) return failure('lease_lost', { retryable: true, checkpoint: accumulated });
    if (!checkpointAvailable(command, runtime)) return failure('checkpoint_unavailable', { checkpoint: accumulated });
    try {
      await withDiscordRetry(
        runtime,
        () => member.roles.add(roleId, 'Nexus AMS application Discord reconciliation'),
        `add application role ${roleId}`,
      );
    } catch (error) {
      const classified = classifyError(error, 'role_add_failed');
      return failure(classified.reason, {
        retryable: classified.retryable,
        reconciliationRequired: true,
        checkpoint: accumulated,
      });
    }
    completedAdds.add(roleId);
    accumulated.roles_added = [...completedAdds];
    const saved = await checkpoint(command, runtime, accumulated, { afterMutation: true });
    if (saved) return saved;
    current.add(roleId);
  }

  for (const roleId of desiredRemoves) {
    if (completedRemoves.has(roleId)) {
      if (current.has(roleId)) return failure('role_state_drift', { retryable: true, checkpoint: accumulated });
      continue;
    }
    if (!current.has(roleId)) {
      completedRemoves.add(roleId);
      accumulated.roles_removed = [...completedRemoves];
      continue;
    }
    if (!canContinue(runtime)) return failure('lease_lost', { retryable: true, checkpoint: accumulated });
    if (!checkpointAvailable(command, runtime)) return failure('checkpoint_unavailable', { checkpoint: accumulated });
    try {
      await withDiscordRetry(
        runtime,
        () => member.roles.remove(roleId, 'Nexus AMS application Discord reconciliation'),
        `remove application role ${roleId}`,
      );
    } catch (error) {
      const classified = classifyError(error, 'role_remove_failed');
      return failure(classified.reason, {
        retryable: classified.retryable,
        reconciliationRequired: true,
        checkpoint: accumulated,
      });
    }
    completedRemoves.add(roleId);
    accumulated.roles_removed = [...completedRemoves];
    const saved = await checkpoint(command, runtime, accumulated, { afterMutation: true });
    if (saved) return saved;
    current.delete(roleId);
  }
  return null;
};

const strictAllowedMentions = () => ({ parse: [], users: [], roles: [], repliedUser: false });

const sendIntroMessages = async (command, runtime, channel, payload, accumulated) => {
  const messages = payload.desired.channel.intro_messages ?? [];
  if (messages.length === 0) return null;
  if (!channel) return failure('channel_unavailable');
  if (typeof runtime?.send !== 'function') return failure('channel_send_unavailable');

  const completed = new Set(accumulated.intro_messages);
  for (const message of messages) {
    if (completed.has(message.key)) continue;
    if (!canContinue(runtime)) return failure('lease_lost', { retryable: true, checkpoint: accumulated });
    if (!checkpointAvailable(command, runtime)) return failure('checkpoint_unavailable', { checkpoint: accumulated });
    try {
      await runtime.send(
        channel,
        command,
        `application-reconcile:intro:${message.key}`,
        { content: message.content, allowedMentions: strictAllowedMentions() },
        `send application intro ${message.key}`,
      );
    } catch (error) {
      const classified = classifyError(error, 'intro_send_failed');
      return failure(classified.reason, {
        retryable: classified.retryable,
        reconciliationRequired: true,
        checkpoint: accumulated,
      });
    }
    completed.add(message.key);
    accumulated.intro_messages = [...completed];
    const saved = await checkpoint(command, runtime, accumulated, { afterMutation: true });
    if (saved) return saved;
  }
  return null;
};

const resolveTextNotificationChannel = async (guild, runtime, channelId) => {
  const resolved = await resolveGuildChannel(guild, runtime, channelId);
  if (!resolved.channel) {
    if (resolved.error) {
      const classified = classifyError(resolved.error, 'notification_channel_fetch_failed');
      return { failure: failure(classified.reason, { retryable: classified.retryable }) };
    }
    return { failure: failure('notification_channel_unavailable', { retryable: true }) };
  }
  if (!guildScopedChannel(resolved.channel, guild.id)) return { failure: failure('wrong_guild_channel') };
  const isTextBased = typeof resolved.channel.isTextBased === 'function'
    ? resolved.channel.isTextBased()
    : resolved.channel.type === ChannelType.GuildText;
  if (!isTextBased) return { failure: failure('notification_channel_not_text') };
  return { channel: resolved.channel };
};

const sendNotifications = async (command, runtime, guild, payload, accumulated) => {
  const notifications = payload.desired.notifications;
  if (notifications.length === 0) return null;
  const completed = new Set(accumulated.notifications);
  for (const notification of notifications) {
    if (completed.has(notification.key)) continue;
    if (!canContinue(runtime)) return failure('lease_lost', { retryable: true, checkpoint: accumulated });
    if (!checkpointAvailable(command, runtime)) return failure('checkpoint_unavailable', { checkpoint: accumulated });

    let destination;
    if (notification.destination.type === 'channel') {
      if (typeof runtime?.send !== 'function') return failure('notification_send_unavailable');
      destination = await resolveTextNotificationChannel(
        guild,
        runtime,
        notification.destination.channel_id.trim(),
      );
      if (destination.failure) return destination.failure;
    } else {
      if (typeof runtime?.sendDirectMessage !== 'function') return failure('notification_send_unavailable');
      let user;
      try {
        user = await runtime.resolveUser(notification.destination.discord_user_id.trim());
      } catch (error) {
        const classified = classifyError(error, 'dm_user_fetch_failed');
        return failure(classified.reason, { retryable: classified.retryable });
      }
      if (!user) return failure('dm_user_unavailable', { retryable: true });
      if (user.id !== undefined && `${user.id}`.trim() !== notification.destination.discord_user_id.trim()) {
        return failure('wrong_dm_user');
      }
      destination = { user };
    }

    try {
      const stepKey = `application-reconcile:notification:${notification.key}`;
      const message = { content: notification.content, allowedMentions: strictAllowedMentions() };
      if (notification.destination.type === 'channel') {
        await runtime.send(destination.channel, command, stepKey, message, `send application notification ${notification.key}`);
      } else {
        await runtime.sendDirectMessage(
          destination.user,
          command,
          stepKey,
          message,
          `send application DM ${notification.key}`,
        );
      }
    } catch (error) {
      const classified = classifyError(error, notification.destination.type === 'dm' ? 'dm_send_failed' : 'notification_send_failed');
      return failure(classified.reason, {
        retryable: classified.retryable,
        reconciliationRequired: true,
        checkpoint: accumulated,
      });
    }

    completed.add(notification.key);
    accumulated.notifications = [...completed];
    const saved = await checkpoint(command, runtime, accumulated, { afterMutation: true });
    if (saved) return saved;
  }
  return null;
};

const deleteAuthoritativeChannel = async (command, runtime, guild, payload, accumulated) => {
  if (accumulated.channel_deleted) return null;
  const channelId = accumulated.channel_id ?? payload.desired.channel.channel_id?.trim() ?? null;
  if (!channelId) {
    const expectedTopic = payload.desired.channel.topic ?? buildApplicationChannelTopic(
      payload.application.id,
      payload.application.nation_id,
    );
    if (!expectedTopic) return failure('invalid_channel_topic');
    const listed = await listGuildChannels(guild);
    if (listed.error) {
      const classified = classifyError(listed.error, 'channel_collection_unavailable');
      return failure(classified.reason, { retryable: classified.retryable });
    }
    const topicMatches = exactTopicCandidates(listed.channels, expectedTopic, guild.id);
    if (topicMatches.failure) return topicMatches.failure;
    if (topicMatches.candidates.length === 0) {
      accumulated.channel_deleted = true;
      return checkpoint(command, runtime, accumulated);
    }
    const recovered = topicMatches.candidates[0];
    const validation = interviewValidation(recovered, payload, guild.id);
    if (!validation.valid) return failure(validation.reason);
    accumulated.channel_id = recovered.id.trim();
    if (typeof recovered.delete !== 'function') return failure('channel_delete_unavailable');
    if (!canContinue(runtime)) return failure('lease_lost', { retryable: true, checkpoint: accumulated });
    if (!checkpointAvailable(command, runtime)) return failure('checkpoint_unavailable', { checkpoint: accumulated });
    try {
      await withDiscordRetry(runtime, () => recovered.delete('Nexus AMS application Discord reconciliation'), 'delete application interview channel');
    } catch (error) {
      if (isUnknownChannel(error)) {
        accumulated.channel_deleted = true;
        const saved = await checkpoint(command, runtime, accumulated);
        return saved ?? null;
      }
      const classified = classifyError(error, 'channel_delete_failed');
      return failure(classified.reason, {
        retryable: classified.retryable,
        reconciliationRequired: true,
        checkpoint: accumulated,
      });
    }
    accumulated.channel_deleted = true;
    return checkpoint(command, runtime, accumulated, { afterMutation: true });
  }

  const resolved = await resolveGuildChannel(guild, runtime, channelId);
  if (!resolved.channel) {
    if (resolved.error && !resolved.unknown) {
      const classified = classifyError(resolved.error, 'channel_fetch_failed');
      return failure(classified.reason, { retryable: classified.retryable, checkpoint: accumulated });
    }
    accumulated.channel_deleted = true;
    return checkpoint(command, runtime, accumulated);
  }
  if (!guildScopedChannel(resolved.channel, guild.id)) return failure('wrong_guild_channel');
  const validation = interviewValidation(resolved.channel, payload, guild.id);
  if (!validation.valid) return failure(validation.reason);
  if (typeof resolved.channel.delete !== 'function') return failure('channel_delete_unavailable');
  if (!canContinue(runtime)) return failure('lease_lost', { retryable: true, checkpoint: accumulated });
  if (!checkpointAvailable(command, runtime)) return failure('checkpoint_unavailable', { checkpoint: accumulated });

  try {
    await withDiscordRetry(runtime, () => resolved.channel.delete('Nexus AMS application Discord reconciliation'), 'delete application interview channel');
  } catch (error) {
    if (isUnknownChannel(error)) {
      accumulated.channel_deleted = true;
      const saved = await checkpoint(command, runtime, accumulated);
      return saved ?? null;
    }
    const classified = classifyError(error, 'channel_delete_failed');
    return failure(classified.reason, {
      retryable: classified.retryable,
      reconciliationRequired: true,
      checkpoint: accumulated,
    });
  }
  accumulated.channel_deleted = true;
  return checkpoint(command, runtime, accumulated, { afterMutation: true });
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
  if (observed.applicationId !== undefined
    && `${observed.applicationId}`.trim() !== payload.installation.application_id.trim()) {
    return failure('wrong_application');
  }
  if (observed.connectionId !== undefined
    && `${observed.connectionId}`.trim() !== payload.installation.connection_id.trim()) {
    return failure('wrong_connection');
  }
  if (observed.generation !== undefined && observed.generation !== payload.installation.generation) {
    return failure('stale_connection_generation');
  }
  return null;
};

export const execute = async (command, runtime) => {
  const payload = command?.payload;
  const validation = validate(payload);
  if (!validation.valid) return failure(validation.reason);

  const contextFailure = validateRuntimeContext(command, runtime, payload);
  if (contextFailure) return contextFailure;
  if (!canContinue(runtime)) return failure('lease_lost', { retryable: true });

  const checkpointResult = normalizeCheckpoint(command?.result?.application_reconcile, payload);
  if (!checkpointResult.valid) return failure(checkpointResult.reason);
  const accumulated = checkpointResult.value;
  if (!accumulated.channel_id && payload.desired.channel.channel_id) {
    accumulated.channel_id = payload.desired.channel.channel_id.trim();
  }

  const preflightFailure = await checkpoint(command, runtime, accumulated);
  if (preflightFailure) return preflightFailure;

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

  if (payload.desired.channel.mode === 'absent') {
    const deleted = await deleteAuthoritativeChannel(command, runtime, guild, payload, accumulated);
    if (deleted) return deleted;
  }

  let channel = null;
  if (payload.desired.channel.mode === 'ensure') {
    const ensured = await ensureChannel(command, runtime, guild, payload, accumulated);
    if (ensured.failure) return ensured.failure;
    channel = ensured.channel;
  } else if (payload.desired.channel.mode === 'unchanged'
    && (payload.desired.channel.intro_messages?.length ?? 0) > 0) {
    const channelId = accumulated.channel_id ?? payload.desired.channel.channel_id?.trim() ?? null;
    if (!channelId) return failure('channel_unavailable');
    const resolved = await resolveGuildChannel(guild, runtime, channelId);
    if (!resolved.channel) {
      if (resolved.error) {
        const classified = classifyError(resolved.error, 'channel_fetch_failed');
        return failure(classified.reason, { retryable: classified.retryable });
      }
      return failure('channel_unavailable', { retryable: true });
    }
    if (!guildScopedChannel(resolved.channel, guild.id)) return failure('wrong_guild_channel');
    const interview = interviewValidation(resolved.channel, payload, guild.id);
    if (!interview.valid) return failure(interview.reason);
    channel = resolved.channel;
  }

  const roleFailure = await syncRoles(command, runtime, guild, payload, accumulated);
  if (roleFailure) return roleFailure;
  const introFailure = await sendIntroMessages(command, runtime, channel, payload, accumulated);
  if (introFailure) return introFailure;
  const notificationFailure = await sendNotifications(command, runtime, guild, payload, accumulated);
  if (notificationFailure) return notificationFailure;
  return success(accumulated);
};
