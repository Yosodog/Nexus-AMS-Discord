import { isDiscordSnowflake } from '../../utils/boundaryValidators.js';
import {
  buildEmbed,
  escapeMarkdown,
  formatDiscordTime,
  formatNumber,
  markdownLink,
  resolveDeepLink,
  statusLabel,
  statusTone,
  titleCase,
} from '../../utils/discordUi.js';

const EVENT_TEMPLATES = Object.freeze([
  { prefix: 'grant_', title: 'Grant Update', label: 'grant request', tone: 'finance' },
  { prefix: 'city_grant_', title: 'City Grant Update', label: 'city grant request', tone: 'finance' },
  { prefix: 'loan_', title: 'Loan Update', label: 'loan', tone: 'finance' },
  { prefix: 'war_aid_', title: 'War Aid Update', label: 'war aid request', tone: 'military' },
  { prefix: 'rebuilding_', title: 'Rebuilding Update', label: 'rebuilding request', tone: 'info' },
  { prefix: 'application_', title: 'Application Update', label: 'application', tone: 'info' },
  { prefix: 'war_assignment_', title: 'War Assignment Update', label: 'war assignment', tone: 'military' },
  { prefix: 'spy_assignment_', title: 'Spy Assignment Update', label: 'spy assignment', tone: 'intelligence' },
  { prefix: 'audit_', title: 'Audit Findings Need Attention', label: 'audit findings', tone: 'warning' },
  { prefix: 'watchlist_', title: 'Watchlist Alert', label: 'watchlist', tone: 'warning' },
  { prefix: 'blockade_relief_', title: 'Blockade Relief', label: 'blockade relief request', tone: 'military' },
]);

const safeScalar = (value) => ['string', 'number', 'boolean'].includes(typeof value)
  && `${value}`.length <= 200 && !/[\r\n]/.test(`${value}`);
const templateFor = (eventType) => EVENT_TEMPLATES.find(({ prefix }) => eventType.startsWith(prefix));

const summaryValue = (key, value) => {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return formatNumber(value);
  if (key.endsWith('_at') || key.endsWith('_date')) {
    const formatted = formatDiscordTime(value, 'f');
    if (formatted !== '—') return formatted;
  }
  return escapeMarkdown(value);
};

const SUMMARY_LABELS = Object.freeze({
  alert_type: 'Type',
  city_number: 'City',
  cycle_id: 'Cycle',
  finding_count: 'Active findings',
  overdue_count: 'Overdue',
});

const summaryLines = (summary, excluded = []) => Object.entries(summary)
  .filter(([key, value]) => !excluded.includes(key) && value !== null && value !== '')
  .slice(0, 5)
  .map(([key, value]) => `**${SUMMARY_LABELS[key] ?? escapeMarkdown(titleCase(key))}:** ${summaryValue(key, value)}`);

const auditDescription = (payload, label, deepLink) => {
  const rawCount = Number(payload.summary.finding_count);
  const count = Number.isInteger(rawCount) && rawCount >= 0 ? rawCount : null;
  const specificFinding = payload.summary.finding_name
    ?? payload.summary.finding
    ?? (label.toLowerCase() === 'audit findings' ? null : label);
  const headline = count === null
    ? '**Your nation has active audit findings that need attention.**'
    : `**${formatNumber(count, { maximumFractionDigits: 0 })} active audit ${count === 1 ? 'finding needs' : 'findings need'} attention.**`;
  return [
    headline,
    specificFinding ? `**Finding:** ${escapeMarkdown(specificFinding)}` : null,
    payload.summary.description ? escapeMarkdown(payload.summary.description) : null,
    ...summaryLines(payload.summary, ['status', 'event', 'finding_count', 'finding_name', 'finding', 'description']),
    specificFinding || payload.summary.description
      ? null
      : 'Open Nexus to review what was detected, why it matters, and how to clear it.',
    deepLink ? markdownLink('Review audit findings in Nexus', deepLink) : null,
  ].filter(Boolean).join('\n');
};

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
  const isAudit = payload.event_type.startsWith('audit_');
  const status = typeof payload.summary.status === 'string' ? payload.summary.status : 'updated';
  const label = typeof payload.subject?.label === 'string' && payload.subject.label.length <= 80
    ? payload.subject.label
    : isAudit ? template.label : `${titleCase(template.label)} #${payload.subject.id}`;
  const showsEvent = payload.event_type.startsWith('watchlist_')
    || payload.event_type.startsWith('blockade_relief_');
  const event = showsEvent && typeof payload.summary.event === 'string' ? payload.summary.event : null;
  const deepLink = resolveDeepLink(runtime.apiService?.baseUrl, payload.deep_link_path);
  const description = isAudit ? auditDescription(payload, label, deepLink) : [
    `**${escapeMarkdown(label)}**`,
    statusLabel(status) ?? '• Updated',
    event ? escapeMarkdown(event) : null,
    ...summaryLines(payload.summary, ['status', 'event']),
    deepLink ? markdownLink('View details in Nexus', deepLink) : null,
  ].filter(Boolean).join('\n');
  const occurredAt = new Date(payload.occurred_at);
  const embed = buildEmbed({
    title: template.title,
    description,
    tone: statusTone(status, template.tone),
    url: deepLink,
  });
  if (!Number.isNaN(occurredAt.getTime())) embed.setTimestamp(occurredAt);
  const message = {
    embeds: [embed],
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
