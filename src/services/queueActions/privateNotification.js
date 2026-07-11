import { EmbedBuilder } from 'discord.js';
import { isDiscordSnowflake } from '../../utils/boundaryValidators.js';

const EVENT_TEMPLATES = Object.freeze([
  { prefix: 'grant_', title: 'Grant Update', label: 'grant request' },
  { prefix: 'city_grant_', title: 'City Grant Update', label: 'city grant request' },
  { prefix: 'loan_', title: 'Loan Update', label: 'loan' },
  { prefix: 'war_aid_', title: 'War Aid Update', label: 'war aid request' },
  { prefix: 'rebuilding_', title: 'Rebuilding Update', label: 'rebuilding request' },
  { prefix: 'application_', title: 'Application Update', label: 'application' },
  { prefix: 'war_assignment_', title: 'War Assignment Update', label: 'war assignment' },
  { prefix: 'spy_assignment_', title: 'Spy Assignment Update', label: 'spy assignment' },
  { prefix: 'audit_', title: 'Audit Reminder', label: 'audit findings' },
  { prefix: 'watchlist_', title: 'Watchlist Alert', label: 'watchlist' },
  { prefix: 'blockade_relief_', title: 'Blockade Relief', label: 'blockade relief request' },
]);

const safeScalar = (value) => ['string', 'number', 'boolean'].includes(typeof value)
  && `${value}`.length <= 200 && !/[\r\n]/.test(`${value}`);
const templateFor = (eventType) => EVENT_TEMPLATES.find(({ prefix }) => eventType.startsWith(prefix));

export const validate = (payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { valid: false, reason: 'invalid_payload' };
  if (payload.contract_version !== 1) return { valid: false, reason: 'unsupported_contract_version' };
  if (!isDiscordSnowflake(payload.recipient_discord_id)) return { valid: false, reason: 'invalid_discord_user_id' };
  if (typeof payload.event_type !== 'string' || !templateFor(payload.event_type)) return { valid: false, reason: 'invalid_event_type' };
  if (typeof payload.notification_id !== 'string' || payload.notification_id.length > 100) return { valid: false, reason: 'invalid_notification_id' };
  if (typeof payload.deep_link_path !== 'string' || !/^\/[A-Za-z0-9/_-]{0,254}$/.test(payload.deep_link_path)) {
    return { valid: false, reason: 'invalid_deep_link_path' };
  }
  if (!payload.subject || typeof payload.subject !== 'object' || Array.isArray(payload.subject)
    || typeof payload.subject.type !== 'string' || !safeScalar(payload.subject.type)
    || !['string', 'number'].includes(typeof payload.subject.id)
    || (payload.subject.label !== undefined && !safeScalar(payload.subject.label))) {
    return { valid: false, reason: 'invalid_notification_subject' };
  }
  if (Object.hasOwn(payload, 'message') || Object.hasOwn(payload, 'content') || Object.hasOwn(payload, 'url')) {
    return { valid: false, reason: 'unsafe_notification_payload' };
  }
  if (!payload.summary || typeof payload.summary !== 'object' || Array.isArray(payload.summary)
    || Object.values(payload.summary).some((value) => value !== null && !safeScalar(value))) {
    return { valid: false, reason: 'invalid_notification_summary' };
  }
  return { valid: true };
};

export const execute = async (command, runtime) => {
  if (!runtime.canContinue()) return { success: false, reason: 'lease_lost' };
  const payload = command.payload;
  const user = await runtime.resolveUser(payload.recipient_discord_id);
  if (!user) {
    return { success: true, result: { delivery: 'undeliverable', reason: 'user_unavailable' } };
  }
  const template = templateFor(payload.event_type);
  const status = typeof payload.summary.status === 'string'
    ? payload.summary.status.replaceAll('_', ' ').toLowerCase()
    : 'updated';
  const label = typeof payload.subject?.label === 'string' && payload.subject.label.length <= 80
    ? ` (${payload.subject.label})` : '';
  const showsEvent = payload.event_type.startsWith('watchlist_')
    || payload.event_type.startsWith('blockade_relief_');
  const event = showsEvent && typeof payload.summary.event === 'string'
    ? `\n${payload.summary.event}` : '';
  const description = `Your ${template.label}${label} was ${status}.${event}\nOpen Nexus: \`${payload.deep_link_path}\``;
  const message = {
    embeds: [new EmbedBuilder().setTitle(template.title).setDescription(description).setColor(0x5865f2)],
    allowedMentions: { parse: [], repliedUser: false },
  };
  try {
    const sent = await runtime.sendDirectMessage(user, command, 'private-notification', message, 'send private notification');
    return { success: true, result: { delivery: 'delivered', discord_message_id: `${sent?.id ?? ''}` || null } };
  } catch (error) {
    runtime.logger.warn('Private notification could not be delivered', {
      commandId: command.id ?? null,
      discordUserId: payload.recipient_discord_id,
      errorCode: error?.code ?? null,
    });
    return { success: true, result: { delivery: 'undeliverable', reason: 'dm_failed' } };
  }
};
