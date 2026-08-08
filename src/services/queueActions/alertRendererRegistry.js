import {
  buildEmbed,
  escapeMarkdown,
  formatDiscordTime,
  formatNumber,
  markdownLink,
  statusLabel,
  statusTone,
  titleCase,
  truncate,
} from '../../utils/discordUi.js';

const MEMBER_EVENT_KEYS = Object.freeze([
  'nation.alliance.changed',
  'nation.vacation.entered',
  'nation.vacation.exited',
  'nation.beige.exited',
  'nation.city_count.changed',
  'nation.active_wars.changed',
  'alliance.membership.changed',
  'alliance.treaty.changed',
  'market.price.crossed',
]);

const WORKFLOW_EVENT_KEYS = Object.freeze([
  'application.status.changed',
  'finance.grant.status.changed',
  'finance.city_grant.status.changed',
  'finance.loan.status.changed',
  'finance.war_aid.status.changed',
  'finance.rebuilding.status.changed',
  'finance.deposit.status.changed',
  'finance.withdrawal.status.changed',
  'audit.summary.ready',
  'blockade_relief.request.changed',
]);

const OPERATIONAL_EVENT_KEYS = Object.freeze([
  'beige.turn.window',
  'beige.early_exit',
  'member.inactivity.entered',
  'member.inactivity.reminder',
  'member.departed',
  'discord.destination.unhealthy',
  'ingestion.record.quarantined',
]);

const MILCOM_EVENT_KEYS = Object.freeze([
  'milcom.incident.detected',
  'milcom.raid_policy.violation',
  'milcom.discord_dispatch.failed',
]);

const ASSIGNMENT_EVENT_PATTERN = /(?:^|[._-])(war|spy)[._-]assignment(?:$|[._-])/i;

const TEMPLATE_DATA_FIELDS = Object.freeze([
  'added',
  'aggressor_nation_id',
  'alliance_id',
  'alliance_name',
  'attacked_nation_id',
  'beige',
  'cities',
  'count',
  'current_value',
  'days_inactive',
  'description',
  'destination_id',
  'detail',
  'direction',
  'dispatch_id',
  'event',
  'failure_code',
  'finding_count',
  'friendly_nation_name',
  'incident_id',
  'label',
  'name',
  'nation_id',
  'nation_name',
  'nations',
  'new_value',
  'objective_id',
  'observed_at',
  'offensive_wars',
  'old_alliance_id',
  'old_cities',
  'old_value',
  'operation_id',
  'overdue_count',
  'price',
  'priority',
  'queue_id',
  'reason',
  'removed',
  'resource',
  'severity',
  'source',
  'status',
  'subject_label',
  'target_nation_name',
  'threshold',
  'title',
  'turn',
  'vacation_mode',
  'war_id',
  'defensive_wars',
]);

const EVENT_LABELS = Object.freeze({
  'nation.alliance.changed': 'Nation alliance changed',
  'nation.vacation.entered': 'Nation entered vacation mode',
  'nation.vacation.exited': 'Nation left vacation mode',
  'nation.beige.exited': 'Nation left beige mode',
  'nation.city_count.changed': 'Nation city count changed',
  'nation.active_wars.changed': 'Nation war state changed',
  'alliance.membership.changed': 'Alliance membership changed',
  'alliance.treaty.changed': 'Alliance treaty changed',
  'market.price.crossed': 'Market threshold crossed',
  'application.status.changed': 'Application status changed',
  'finance.grant.status.changed': 'Grant status changed',
  'finance.city_grant.status.changed': 'City grant status changed',
  'finance.loan.status.changed': 'Loan status changed',
  'finance.war_aid.status.changed': 'War aid status changed',
  'finance.rebuilding.status.changed': 'Rebuilding status changed',
  'finance.deposit.status.changed': 'Deposit status changed',
  'finance.withdrawal.status.changed': 'Withdrawal status changed',
  'audit.summary.ready': 'Audit summary ready',
  'blockade_relief.request.changed': 'Blockade relief request changed',
  'milcom.incident.detected': 'Milcom v2 incident detected',
  'milcom.raid_policy.violation': 'Milcom v2 raid-policy violation',
  'milcom.discord_dispatch.failed': 'Milcom v2 Discord dispatch failed',
  'beige.turn.window': 'Beige turn window',
  'beige.early_exit': 'Beige early exit',
  'member.inactivity.entered': 'Member became inactive',
  'member.inactivity.reminder': 'Inactivity reminder',
  'member.departed': 'Member departed',
  'discord.destination.unhealthy': 'Discord destination unhealthy',
  'ingestion.record.quarantined': 'Ingestion record quarantined',
});

const EVENT_TEMPLATE_KEYS = new Map([
  ...MEMBER_EVENT_KEYS.map((eventKey) => [eventKey, 'member_alert_v1']),
  ...WORKFLOW_EVENT_KEYS.map((eventKey) => [eventKey, 'workflow_status_v1']),
  ...OPERATIONAL_EVENT_KEYS.map((eventKey) => [eventKey, 'operational_alert_v1']),
  ...MILCOM_EVENT_KEYS.map((eventKey) => [eventKey, 'milcom_alert_v1']),
]);

const isSafeScalar = (value) => {
  if (!['string', 'number', 'boolean'].includes(typeof value)) return false;
  if (typeof value === 'number' && !Number.isFinite(value)) return false;
  const text = `${value}`;
  return text.length <= 500 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text);
};

const isSafeTemplateValue = (value) => value === null
  || isSafeScalar(value)
  || (Array.isArray(value)
    && value.length <= 20
    && value.every((item) => isSafeScalar(item)));

export const isSafeRelativePath = (value) => typeof value === 'string'
  && value.length > 0
  && value.length <= 512
  && value.startsWith('/')
  && !value.startsWith('//')
  && !/[\\\u0000-\u001f\u007f]/.test(value)
  && !/^[^/?#]*:\/\//.test(value);

const validateScalarFields = (data, allowedFields = TEMPLATE_DATA_FIELDS) => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const allowed = new Set(allowedFields);
  return Object.entries(data).every(([key, value]) => allowed.has(key) && isSafeTemplateValue(value));
};

const validateDigestData = (data) => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const allowed = new Set(['count', 'description', 'items', 'remaining_count', 'remaining_items_path', 'title']);
  if (Object.keys(data).some((key) => !allowed.has(key))) return false;
  if (data.count !== undefined && (!Number.isSafeInteger(data.count) || data.count < 0)) return false;
  if (data.remaining_count !== undefined
    && (!Number.isSafeInteger(data.remaining_count) || data.remaining_count < 0)) return false;
  if (data.description !== undefined && !isSafeScalar(data.description)) return false;
  if (data.title !== undefined && !isSafeScalar(data.title)) return false;
  if (data.remaining_items_path !== undefined && !isSafeRelativePath(data.remaining_items_path)) return false;
  if (!Array.isArray(data.items) || data.items.length > 20 || data.items.length === 0) return false;

  return data.items.every((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const keys = Object.keys(item);
    if (keys.some((key) => !['deep_link_path', 'description', 'event_key', 'occurred_at', 'title'].includes(key))) {
      return false;
    }
    return typeof item.title === 'string'
      && item.title.length > 0
      && item.title.length <= 200
      && isSafeScalar(item.description ?? '')
      && typeof item.event_key === 'string'
      && EVENT_TEMPLATE_KEYS.has(item.event_key)
      && typeof item.occurred_at === 'string'
      && !Number.isNaN(new Date(item.occurred_at).getTime())
      && isSafeRelativePath(item.deep_link_path);
  });
};

const validateDataForTemplate = (templateKey, data) => templateKey === 'digest.v1'
  ? validateDigestData(data)
  : validateScalarFields(data);

const displayValue = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return escapeMarkdown(truncate(value.join(', '), 300));
  return escapeMarkdown(truncate(value, 300));
};

const eventTitle = (eventKey, fallback) => EVENT_LABELS[eventKey] ?? fallback;

const renderStandardAlert = ({ definition, eventKey, data, deepLink, occurredAt, observedAt }) => {
  const subject = data.subject_label ?? data.label ?? data.name ?? null;
  const event = data.event ?? eventTitle(eventKey, definition.title);
  const status = statusLabel(data.status);
  const changes = data.old_value !== undefined || data.new_value !== undefined
    ? `**Change:** ${displayValue(data.old_value) ?? '—'} → ${displayValue(data.new_value) ?? '—'}`
    : data.old_cities !== undefined || data.cities !== undefined
      ? `**Cities:** ${displayValue(data.old_cities) ?? '—'} → ${displayValue(data.cities) ?? '—'}`
      : data.old_alliance_id !== undefined || data.alliance_id !== undefined
        ? `**Alliance:** ${displayValue(data.old_alliance_id) ?? '—'} → ${displayValue(data.alliance_id) ?? '—'}`
        : null;
  const threshold = data.threshold !== undefined
    ? `**Threshold:** ${displayValue(data.threshold)}${data.direction ? ` (${escapeMarkdown(data.direction)})` : ''}`
    : null;
  const description = [
    subject ? `**${escapeMarkdown(subject)}**` : null,
    `**Event:** ${escapeMarkdown(event)}`,
    status,
    changes,
    threshold,
    data.price !== undefined ? `**Observed price:** ${displayValue(data.price)}` : null,
    data.offensive_wars !== undefined || data.defensive_wars !== undefined
      ? `**Active wars:** ${displayValue(data.offensive_wars ?? 0)} offensive, ${displayValue(data.defensive_wars ?? 0)} defensive`
      : null,
    data.added !== undefined ? `**Added:** ${displayValue(data.added)}` : null,
    data.removed !== undefined ? `**Removed:** ${displayValue(data.removed)}` : null,
    data.finding_count !== undefined ? `**Audit findings:** ${displayValue(data.finding_count)}` : null,
    data.overdue_count !== undefined ? `**Overdue:** ${displayValue(data.overdue_count)}` : null,
    data.war_id !== undefined ? `**War:** #${displayValue(data.war_id)}` : null,
    data.incident_id !== undefined ? `**Incident:** #${displayValue(data.incident_id)}` : null,
    data.description ? escapeMarkdown(data.description) : null,
    data.detail ? escapeMarkdown(data.detail) : null,
    data.reason ? `**Reason:** ${escapeMarkdown(data.reason)}` : null,
    observedAt ? `**Observed:** ${formatDiscordTime(observedAt)}` : null,
    deepLink ? markdownLink('Open details in Nexus', deepLink) : null,
  ].filter(Boolean).join('\n');

  const timestamp = new Date(occurredAt);
  const embed = buildEmbed({
    title: definition.title,
    description,
    tone: statusTone(data.status, definition.tone),
    url: deepLink,
  });
  if (!Number.isNaN(timestamp.getTime())) embed.setTimestamp(timestamp);
  return {
    embeds: [embed],
  };
};

const renderDigest = ({ data, deepLink, remainingItemsLink, observedAt }) => {
  const fields = data.items.map((item) => {
    const itemLink = deepLinkForPath(deepLink, item.deep_link_path);
    return {
      name: escapeMarkdown(item.title),
      value: [
        escapeMarkdown(item.description),
        `**Occurred:** ${formatDiscordTime(item.occurred_at)}`,
        itemLink ? markdownLink('Open in Nexus', itemLink) : null,
      ].filter(Boolean).join('\n'),
      inline: false,
    };
  });

  const remainingCount = data.remaining_count
    ?? (data.count !== undefined ? Math.max(data.count - data.items.length, 0) : 0);

  return {
    embeds: [buildEmbed({
      title: data.title ?? 'Nexus Alert Digest',
      description: [
        data.description ? escapeMarkdown(data.description) : null,
        data.count !== undefined ? `**Items:** ${formatNumber(data.count, { maximumFractionDigits: 0 })}` : null,
        observedAt ? `**Generated:** ${formatDiscordTime(observedAt)}` : null,
        remainingCount > 0 && (remainingItemsLink ?? deepLink)
          ? markdownLink(`View ${formatNumber(remainingCount, { maximumFractionDigits: 0 })} remaining items in Nexus`, remainingItemsLink ?? deepLink)
          : deepLink ? markdownLink('Open alert activity in Nexus', deepLink) : null,
      ].filter(Boolean).join('\n'),
      tone: 'info',
      url: deepLink,
      fields,
    })],
  };
};

const deepLinkForPath = (baseLink, path) => {
  if (!baseLink || !isSafeRelativePath(path)) return null;
  try {
    const base = new URL(baseLink);
    const candidate = new URL(path, base);
    return candidate.origin === base.origin ? candidate.toString() : null;
  } catch {
    return null;
  }
};

const DEFINITIONS = Object.freeze([
  {
    template_key: 'member_alert_v1',
    version: 1,
    event_keys: MEMBER_EVENT_KEYS,
    title: 'Nexus Watchlist Alert',
    tone: 'info',
    render: renderStandardAlert,
  },
  {
    template_key: 'workflow_status_v1',
    version: 1,
    event_keys: WORKFLOW_EVENT_KEYS,
    title: 'Nexus Workflow Update',
    tone: 'finance',
    render: renderStandardAlert,
  },
  {
    template_key: 'milcom_alert_v1',
    version: 1,
    event_keys: MILCOM_EVENT_KEYS,
    title: 'Milcom v2 Alert',
    tone: 'military',
    render: renderStandardAlert,
  },
  {
    template_key: 'operational_alert_v1',
    version: 1,
    event_keys: OPERATIONAL_EVENT_KEYS,
    title: 'Nexus Operations Alert',
    tone: 'warning',
    render: renderStandardAlert,
  },
  {
    template_key: 'digest.v1',
    version: 1,
    event_keys: [...MEMBER_EVENT_KEYS, ...WORKFLOW_EVENT_KEYS, ...OPERATIONAL_EVENT_KEYS, ...MILCOM_EVENT_KEYS],
    title: 'Nexus Alert Digest',
    tone: 'info',
    render: renderDigest,
  },
]);

const RENDERERS = new Map(DEFINITIONS.map((definition) => [definition.template_key, definition]));

export const ALERT_RENDERER_MANIFEST = Object.freeze({
  contract_version: 1,
  templates: Object.freeze(DEFINITIONS.map(({ template_key, version, event_keys }) => Object.freeze({
    template_key,
    version,
    event_keys: Object.freeze([...event_keys]),
  }))),
});

export class AlertRendererRegistry {
  getManifest() {
    return ALERT_RENDERER_MANIFEST;
  }

  get(templateKey) {
    return RENDERERS.get(templateKey) ?? null;
  }

  templateForEvent(eventKey) {
    return EVENT_TEMPLATE_KEYS.get(eventKey) ?? null;
  }

  validate(templateKey, eventKey, data) {
    const definition = this.get(templateKey);
    if (!definition) return { valid: false, reason: 'unsupported_template' };
    if (!definition.event_keys.includes(eventKey)) return { valid: false, reason: 'template_event_mismatch' };
    if (!validateDataForTemplate(templateKey, data)) return { valid: false, reason: 'invalid_template_data' };
    return { valid: true };
  }

  render(templateKey, context) {
    const definition = this.get(templateKey);
    if (!definition) throw new TypeError(`Unsupported alert renderer: ${templateKey}`);
    return definition.render({ definition, ...context });
  }

  verifyManifest(remoteManifest) {
    const manifest = remoteManifest?.data?.manifest
      ?? remoteManifest?.manifest
      ?? remoteManifest?.data
      ?? remoteManifest;
    if (!manifest || typeof manifest !== 'object' || manifest.contract_version !== 1) {
      return { valid: false, reason: 'invalid_alert_manifest' };
    }

    const remoteTemplates = Array.isArray(manifest.templates)
      ? manifest.templates.filter((template) => template?.active !== false)
      : null;
    if (!remoteTemplates) return { valid: false, reason: 'invalid_alert_manifest_templates' };

    if (remoteTemplates.some((template) => (template?.event_keys ?? [])
      .some((eventKey) => typeof eventKey === 'string' && ASSIGNMENT_EVENT_PATTERN.test(eventKey)))) {
      return { valid: false, reason: 'assignment_events_not_supported' };
    }

    const missing = [];
    const mismatched = [];
    const seen = new Set();
    for (const template of remoteTemplates) {
      const key = template?.template_key;
      const version = template?.version;
      const identity = `${key}:${version}`;
      if (seen.has(identity)) return { valid: false, reason: 'duplicate_alert_manifest_template' };
      seen.add(identity);

      const local = this.get(key);
      if (!local) {
        missing.push(identity);
        continue;
      }
      if (local.version !== version) mismatched.push(identity);
      if (!Array.isArray(template.event_keys)) {
        mismatched.push(`${identity}:event_keys`);
      } else {
        const localEvents = new Set(local.event_keys);
        const remoteEvents = new Set(template.event_keys);
        const sameEvents = localEvents.size === remoteEvents.size
          && [...localEvents].every((eventKey) => remoteEvents.has(eventKey));
        if (!sameEvents) mismatched.push(`${identity}:events`);
      }
    }

    if (missing.length || mismatched.length) {
      return { valid: false, reason: 'alert_manifest_mismatch', missing, mismatched };
    }

    const expected = new Set(ALERT_RENDERER_MANIFEST.templates.map((template) =>
      `${template.template_key}:${template.version}`));
    const actual = new Set(remoteTemplates.map((template) =>
      `${template.template_key}:${template.version}`));
    const missingLocal = [...expected].filter((identity) => !actual.has(identity));
    if (missingLocal.length) {
      return { valid: false, reason: 'alert_manifest_mismatch', missing: missingLocal, mismatched: [] };
    }

    return { valid: true, contract_version: manifest.contract_version };
  }
}

export const alertRendererRegistry = new AlertRendererRegistry();

export const alertEventKeys = Object.freeze([
  ...MEMBER_EVENT_KEYS,
  ...WORKFLOW_EVENT_KEYS,
  ...OPERATIONAL_EVENT_KEYS,
  ...MILCOM_EVENT_KEYS,
]);

export const isSupportedAlertEvent = (eventKey) => EVENT_TEMPLATE_KEYS.has(eventKey);

export const templateForAlertEvent = (eventKey) => EVENT_TEMPLATE_KEYS.get(eventKey) ?? null;

export const normalizeAlertEventLabel = (eventKey) => EVENT_LABELS[eventKey] ?? titleCase(eventKey);

export const resolveRelativeNexusLink = (baseUrl, path) => {
  if (!isSafeRelativePath(path)) return null;
  try {
    const base = new URL(baseUrl);
    if (!['http:', 'https:'].includes(base.protocol)) return null;
    const candidate = new URL(path, base);
    return candidate.origin === base.origin ? candidate.toString() : null;
  } catch {
    return null;
  }
};
