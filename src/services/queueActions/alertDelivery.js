import { isDiscordSnowflake } from '../../utils/boundaryValidators.js';
import {
  alertErrorReceipt,
  isRetryableAlertClassification,
  retryAfterMs,
} from './errorClassification.js';
import {
  alertRendererRegistry,
  isSafeRelativePath,
  isSupportedAlertEvent,
  resolveRelativeNexusLink,
} from './alertRendererRegistry.js';

const DESTINATION_TYPES = new Set(['dm', 'channel']);
const TOP_LEVEL_FIELDS = new Set([
  'allowed_role_ids',
  'batch_id',
  'contract_version',
  'data',
  'deep_link_path',
  'delivery_id',
  'destination',
  'event_key',
  'is_test',
  'occurrence_id',
  'occurred_at',
  'observed_at',
  'priority',
  'schema_version',
  'severity',
  'template_key',
]);

const DESTINATION_FIELDS = new Set(['channel_id', 'guild_id', 'type', 'discord_user_id']);
const ASSIGNMENT_EVENT_PATTERN = /(?:^|[._-])(war|spy)[._-]assignment(?:$|[._-])/i;

const boundedString = (value, maxLength = 160) => typeof value === 'string'
  && value.trim().length > 0
  && value.length <= maxLength
  && !/[\u0000-\u001f\u007f]/.test(value);

const validDate = (value, required = false) => {
  if (value === undefined || value === null) return !required;
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime());
};

const validMetadata = (value, maxLength = 160) => value === undefined
  || boundedString(value, maxLength)
  || (Number.isSafeInteger(value) && value >= 0);

const canonicalReceipt = ({
  deliveryId,
  delivery,
  guildId = null,
  channelId = null,
  providerMessageId = null,
  errorCode = null,
  retryable = false,
  retryAfter = null,
}) => {
  const receipt = {
    success: delivery === 'delivered',
    delivery_id: deliveryId ?? null,
    delivery,
    guild_id: guildId,
    channel_id: channelId,
    provider_message_id: providerMessageId,
    error_code: errorCode,
    retryable,
  };
  if (retryAfter !== null && retryAfter !== undefined) receipt.retry_after_ms = retryAfter;
  return receipt;
};

const validationReceipt = (payload, reason) => canonicalReceipt({
  deliveryId: boundedString(payload?.delivery_id) ? payload.delivery_id : null,
  delivery: 'quarantined',
  errorCode: reason,
});

const destinationIds = (destination) => ({
  userId: destination?.discord_user_id ?? destination?.user_id ?? null,
  channelId: destination?.channel_id ?? null,
  guildId: destination?.guild_id ?? null,
});

export const validate = (payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, reason: 'invalid_payload' };
  }
  if (Object.keys(payload).some((key) => !TOP_LEVEL_FIELDS.has(key))) {
    return { valid: false, reason: 'invalid_payload_field' };
  }
  if (payload.contract_version !== 1) return { valid: false, reason: 'unsupported_contract_version' };
  if (!boundedString(payload.delivery_id, 120)) return { valid: false, reason: 'invalid_delivery_id' };
  if (!boundedString(payload.event_key, 100)
    || ASSIGNMENT_EVENT_PATTERN.test(payload.event_key)
    || !isSupportedAlertEvent(payload.event_key)) {
    return { valid: false, reason: 'invalid_event_key' };
  }
  if (!boundedString(payload.template_key, 100)) return { valid: false, reason: 'invalid_template_key' };

  if (payload.schema_version !== 1) return { valid: false, reason: 'unsupported_alert_schema_version' };
  if (!Object.hasOwn(payload, 'data')) return { valid: false, reason: 'missing_template_data' };
  if (payload.is_test === undefined) return { valid: false, reason: 'missing_test_flag' };
  if (typeof payload.is_test !== 'boolean') return { valid: false, reason: 'invalid_test_flag' };
  if (!isSafeRelativePath(payload.deep_link_path)) return { valid: false, reason: 'invalid_deep_link_path' };
  if (!validDate(payload.occurred_at, true) || !validDate(payload.observed_at)) {
    return { valid: false, reason: 'invalid_alert_timestamp' };
  }
  if (!validMetadata(payload.batch_id) || !validMetadata(payload.occurrence_id)
    || !validMetadata(payload.priority)
    || !validMetadata(payload.severity)) {
    return { valid: false, reason: 'invalid_alert_metadata' };
  }

  if (!payload.destination || typeof payload.destination !== 'object' || Array.isArray(payload.destination)) {
    return { valid: false, reason: 'invalid_destination' };
  }
  if (Object.keys(payload.destination).some((key) => !DESTINATION_FIELDS.has(key))) {
    return { valid: false, reason: 'invalid_destination_field' };
  }
  if (!DESTINATION_TYPES.has(payload.destination.type)) return { valid: false, reason: 'invalid_destination_type' };
  const { userId, channelId, guildId } = destinationIds(payload.destination);
  if (payload.destination.type === 'dm') {
    if (Object.keys(payload.destination).sort().join(',') !== 'discord_user_id,type') {
      return { valid: false, reason: 'invalid_dm_destination' };
    }
    if (!isDiscordSnowflake(userId)) return { valid: false, reason: 'invalid_recipient_discord_id' };
  }
  if (payload.destination.type === 'channel') {
    if (Object.keys(payload.destination).sort().join(',') !== 'channel_id,guild_id,type') {
      return { valid: false, reason: 'invalid_channel_destination' };
    }
    if (!isDiscordSnowflake(channelId)) return { valid: false, reason: 'invalid_channel_id' };
    if (!isDiscordSnowflake(guildId)) return { valid: false, reason: 'invalid_guild_id' };
  }

  if (payload.allowed_role_ids !== undefined) {
    if (!Array.isArray(payload.allowed_role_ids) || payload.allowed_role_ids.length > 10
      || new Set(payload.allowed_role_ids).size !== payload.allowed_role_ids.length
      || payload.allowed_role_ids.some((roleId) => !isDiscordSnowflake(roleId))) {
      return { valid: false, reason: 'invalid_allowed_role_ids' };
    }
    if (payload.destination.type === 'dm' && payload.allowed_role_ids.length > 0) {
      return { valid: false, reason: 'dm_role_mentions_not_allowed' };
    }
  }

  return alertRendererRegistry.validate(payload.template_key, payload.event_key, payload.data);
};

const terminalReceipt = (receipt) => ({ success: true, result: receipt });

const retryableReceipt = (receipt) => ({
  success: false,
  reason: receipt.error_code,
  message: receipt.error_code,
  result: receipt,
});

const resolvedIds = (destination, sent) => {
  const destinationId = destinationIds(destination);
  return {
    guild_id: destinationId.guildId ?? sent?.guildId ?? sent?.guild?.id ?? null,
    channel_id: destinationId.channelId ?? sent?.channelId ?? sent?.channel?.id ?? null,
    message_id: sent?.id ?? null,
  };
};

const resolution = async (runtime, method, id) => {
  if (typeof runtime[`${method}WithError`] === 'function') {
    return runtime[`${method}WithError`](id);
  }

  try {
    return { value: await runtime[method](id), error: null };
  } catch (error) {
    return { value: null, error };
  }
};

export const quarantineOnInvalid = true;
export const lane = 'alerts';

export const execute = async (command, runtime) => {
  const payload = command?.payload;
  const validation = validate(payload);
  if (!validation.valid) {
    return terminalReceipt(validationReceipt(payload, validation.reason));
  }
  if (!runtime.canContinue()) return { success: false, reason: 'lease_lost' };

  const deepLink = resolveRelativeNexusLink(runtime.apiService?.baseUrl, payload.deep_link_path);
  if (!deepLink) return terminalReceipt(validationReceipt(payload, 'invalid_deep_link_path'));

  const destination = payload.destination;
  const destinationIdsValue = destinationIds(destination);
  if (destination.type === 'channel' && destinationIdsValue.guildId !== runtime.guildId) {
    return terminalReceipt(canonicalReceipt({
      deliveryId: payload.delivery_id,
      delivery: 'undeliverable',
      guildId: destinationIdsValue.guildId,
      channelId: destinationIdsValue.channelId,
      errorCode: 'foreign_guild',
    }));
  }

  const rendererContext = {
    eventKey: payload.event_key,
    data: payload.data,
    deepLink,
    occurredAt: payload.occurred_at,
    observedAt: payload.observed_at,
    baseUrl: runtime.apiService?.baseUrl,
    remainingItemsLink: resolveRelativeNexusLink(
      runtime.apiService?.baseUrl,
      payload.data?.remaining_items_path ?? payload.deep_link_path,
    ),
  };
  let message;
  try {
    message = alertRendererRegistry.render(payload.template_key, rendererContext);
  } catch (error) {
    runtime.logger.error('Alert renderer failed', {
      commandId: command?.id ?? null,
      deliveryId: payload.delivery_id,
      templateKey: payload.template_key,
      errorCode: error?.code ?? null,
    });
    return terminalReceipt(validationReceipt(payload, 'invalid_payload'));
  }

  message.allowedMentions = {
    parse: [],
    users: [],
    roles: payload.allowed_role_ids ?? [],
    repliedUser: false,
  };

  let target;
  let resolutionError = null;
  if (destination.type === 'dm') {
    const result = await resolution(runtime, 'resolveUser', destinationIdsValue.userId);
    target = result.value;
    resolutionError = result.error;
  } else {
    const result = await resolution(runtime, 'resolveChannel', destinationIdsValue.channelId);
    target = result.value;
    resolutionError = result.error;
    if (target && target.guildId !== runtime.guildId) {
      return terminalReceipt(canonicalReceipt({
        deliveryId: payload.delivery_id,
        delivery: 'undeliverable',
        guildId: target.guildId ?? destinationIdsValue.guildId,
        channelId: destinationIdsValue.channelId,
        errorCode: 'foreign_guild',
      }));
    }
  }

  if (!target) {
    const receipt = resolutionError
      ? alertErrorReceipt(resolutionError, {
          deliveryId: payload.delivery_id,
          guildId: destinationIdsValue.guildId,
          channelId: destinationIdsValue.channelId,
          fallback: destination.type === 'dm' ? 'recipient_unavailable' : 'channel_not_found',
        })
      : {
          classification: destination.type === 'dm' ? 'recipient_unavailable' : 'channel_not_found',
          guild_id: destinationIdsValue.guildId,
          channel_id: destinationIdsValue.channelId,
          error_code: destination.type === 'dm' ? 'recipient_unavailable' : 'channel_not_found',
          retryable: false,
        };
    const publicReceipt = canonicalReceipt({
      deliveryId: payload.delivery_id,
      delivery: isRetryableAlertClassification(receipt.classification) ? 'failed' : 'undeliverable',
      guildId: receipt.guild_id,
      channelId: receipt.channel_id,
      errorCode: receipt.error_code,
      retryable: receipt.retryable,
      retryAfter: receipt.retry_after_ms,
    });
    return isRetryableAlertClassification(receipt.classification)
      ? retryableReceipt(publicReceipt)
      : terminalReceipt(publicReceipt);
  }

  if (destination.type === 'channel' && !target.isTextBased?.()) {
    return terminalReceipt(canonicalReceipt({
      deliveryId: payload.delivery_id,
      delivery: 'undeliverable',
      guildId: destinationIdsValue.guildId,
      channelId: destinationIdsValue.channelId,
      errorCode: 'channel_not_found',
    }));
  }

  try {
    if (!runtime.canContinue()) return { success: false, reason: 'lease_lost' };
    const sent = destination.type === 'dm'
      ? await runtime.sendDirectMessage(target, command, 'alert-delivery', message, 'send alert delivery')
      : await runtime.send(target, command, 'alert-delivery', message, 'send alert delivery');
    const ids = resolvedIds(destination, sent);
    return terminalReceipt(canonicalReceipt({
      deliveryId: payload.delivery_id,
      delivery: 'delivered',
      guildId: ids.guild_id,
      channelId: ids.channel_id,
      providerMessageId: ids.message_id,
    }));
  } catch (error) {
    const receipt = alertErrorReceipt(error, {
      deliveryId: payload.delivery_id,
      guildId: destinationIdsValue.guildId,
      channelId: destinationIdsValue.channelId,
      fallback: destination.type === 'dm' ? 'recipient_unavailable' : 'discord_unavailable',
    });
    if (receipt.classification === 'recipient_unavailable' && retryAfterMs(error) === null) {
      receipt.retryable = false;
    }
    const publicReceipt = canonicalReceipt({
      deliveryId: payload.delivery_id,
      delivery: receipt.retryable ? 'failed' : 'undeliverable',
      guildId: receipt.guild_id,
      channelId: receipt.channel_id,
      errorCode: receipt.error_code,
      retryable: receipt.retryable,
      retryAfter: receipt.retry_after_ms,
    });
    return receipt.retryable ? retryableReceipt(publicReceipt) : terminalReceipt(publicReceipt);
  }
};
