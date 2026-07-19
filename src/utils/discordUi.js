import { EmbedBuilder } from 'discord.js';

export const UI_COLORS = Object.freeze({
  info: 0x5865f2,
  success: 0x57f287,
  warning: 0xfee75c,
  danger: 0xed4245,
  neutral: 0x95a5a6,
  finance: 0x3ba55d,
  military: 0xe67e22,
  intelligence: 0x9b59b6,
});

const RESOURCE_ORDER = [
  'money', 'credits', 'food', 'coal', 'oil', 'uranium', 'lead', 'iron',
  'bauxite', 'gasoline', 'munitions', 'steel', 'aluminum',
];

const RESOURCE_LABELS = Object.freeze({
  money: 'Money',
  credits: 'Credits',
  food: 'Food',
  coal: 'Coal',
  oil: 'Oil',
  uranium: 'Uranium',
  lead: 'Lead',
  iron: 'Iron',
  bauxite: 'Bauxite',
  gasoline: 'Gasoline',
  munitions: 'Munitions',
  steel: 'Steel',
  aluminum: 'Aluminum',
});

const STATUS_META = Object.freeze({
  active: ['●', 'Active', 'success'],
  approved: ['✓', 'Approved', 'success'],
  complete: ['✓', 'Complete', 'success'],
  completed: ['✓', 'Completed', 'success'],
  confirmed: ['✓', 'Confirmed', 'success'],
  eligible: ['✓', 'Eligible', 'success'],
  open: ['●', 'Open', 'info'],
  pending: ['◷', 'Pending', 'warning'],
  planning: ['◷', 'Planning', 'warning'],
  draft: ['◷', 'Draft', 'warning'],
  'needs-attention': ['!', 'Needs attention', 'danger'],
  failed: ['×', 'Failed', 'danger'],
  denied: ['×', 'Denied', 'danger'],
  cancelled: ['×', 'Cancelled', 'neutral'],
  canceled: ['×', 'Cancelled', 'neutral'],
  expired: ['×', 'Expired', 'neutral'],
  paused: ['Ⅱ', 'Paused', 'neutral'],
  inactive: ['○', 'Inactive', 'neutral'],
  snoozed: ['◷', 'Snoozed', 'neutral'],
  acknowledged: ['✓', 'Acknowledged', 'neutral'],
  accepted: ['✓', 'Accepted', 'success'],
  available: ['●', 'Available', 'success'],
  declined: ['×', 'Declined', 'danger'],
  unavailable: ['×', 'Unavailable', 'neutral'],
  high: ['!', 'High priority', 'danger'],
  critical: ['!!', 'Critical', 'danger'],
  warning: ['!', 'Warning', 'warning'],
  info: ['i', 'Info', 'info'],
});

const VARIANTS = Object.freeze({
  account: { color: 'finance', noun: 'account', pageSize: 3 },
  alert: { color: 'warning', noun: 'alert', pageSize: 4 },
  application: { color: 'info', noun: 'application', pageSize: 4 },
  audit: { color: 'warning', noun: 'finding', pageSize: 3 },
  blockade: { color: 'military', noun: 'request', pageSize: 3 },
  'grant-program': { color: 'finance', noun: 'program', pageSize: 3 },
  loan: { color: 'finance', noun: 'loan', pageSize: 3 },
  raid: { color: 'military', noun: 'target', pageSize: 2 },
  request: { color: 'info', noun: 'request', pageSize: 4 },
  spy: { color: 'intelligence', noun: 'assignment', pageSize: 3 },
  transaction: { color: 'finance', noun: 'transaction', pageSize: 4 },
  war: { color: 'military', noun: 'war', pageSize: 3 },
  'war-assignment': { color: 'military', noun: 'assignment', pageSize: 3 },
  'war-counter': { color: 'military', noun: 'counter', pageSize: 3 },
  generic: { color: 'info', noun: 'item', pageSize: 4 },
});

const isPresent = (value) => value !== null && value !== undefined && value !== '';

export const cleanText = (value, fallback = '—') => {
  if (!isPresent(value)) return fallback;
  const text = String(value)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || fallback;
};

export const truncate = (value, maxLength, fallback = '—') => {
  const text = cleanText(value, fallback);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
};

export const escapeMarkdown = (value) => cleanText(value)
  .replace(/([\\`*_{}\[\]()<>#+\-.!|~])/g, '\\$1');

export const titleCase = (value) => cleanText(value)
  .replaceAll('_', ' ')
  .replaceAll('-', ' ')
  .replace(/\b\w/g, (character) => character.toUpperCase());

export const formatNumber = (value, { maximumFractionDigits = 2 } = {}) => {
  if (!isPresent(value)) return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits }).format(number);
};

export const formatMoney = (value) => {
  if (!isPresent(value)) return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: Number.isInteger(number) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(number);
};

export const formatPercent = (value) => {
  if (!isPresent(value)) return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  const percent = Math.abs(number) <= 1 ? number * 100 : number;
  return `${formatNumber(percent, { maximumFractionDigits: 1 })}%`;
};

export const formatDiscordTime = (value, style = 'R') => {
  if (!isPresent(value)) return '—';
  const numericValue = typeof value === 'number' || /^\d+$/.test(String(value)) ? Number(value) : null;
  const date = value instanceof Date
    ? value
    : numericValue !== null && Number.isFinite(numericValue)
      ? new Date(numericValue < 1_000_000_000_000 ? numericValue * 1000 : numericValue)
      : new Date(value);
  const timestamp = Math.floor(date.getTime() / 1000);
  return Number.isFinite(timestamp) ? `<t:${timestamp}:${style}>` : '—';
};

export const safeUrl = (value) => {
  if (!isPresent(value)) return null;
  try {
    const url = new URL(String(value));
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
};

export const resolveDeepLink = (baseUrl, path) => {
  if (!isPresent(path)) return null;
  const direct = safeUrl(path);
  if (direct) return direct;
  const base = safeUrl(baseUrl);
  if (!base || !String(path).startsWith('/')) return null;
  try {
    return new URL(String(path), base).toString();
  } catch {
    return null;
  }
};

export const markdownLink = (label, url) => {
  const text = escapeMarkdown(label);
  const href = safeUrl(url);
  return href ? `[${text}](${href})` : text;
};

export const statusLabel = (status) => {
  if (!isPresent(status)) return null;
  const normalized = String(status).trim().toLowerCase().replaceAll('_', '-');
  const [icon, label] = STATUS_META[normalized] ?? ['•', titleCase(normalized)];
  return `${icon} ${label}`;
};

export const statusTone = (status, fallback = 'info') => {
  if (!isPresent(status)) return fallback;
  const normalized = String(status).trim().toLowerCase().replaceAll('_', '-');
  return STATUS_META[normalized]?.[2] ?? fallback;
};

export const formatResources = (resources, { multiline = true, includeZero = false } = {}) => {
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)) return '—';
  const keys = [...new Set([...RESOURCE_ORDER, ...Object.keys(resources)])];
  const values = keys
    .filter((key) => isPresent(resources[key]))
    .filter((key) => includeZero || Number(resources[key]) !== 0)
    .map((key) => {
      const label = RESOURCE_LABELS[key] ?? titleCase(key);
      const amount = key === 'money' ? formatMoney(resources[key]) : formatNumber(resources[key]);
      return `**${escapeMarkdown(label)}:** ${amount}`;
    });
  if (!values.length) return 'None';
  if (!multiline) return values.join(' · ');
  const lines = [];
  for (let index = 0; index < values.length; index += 2) lines.push(values.slice(index, index + 2).join(' · '));
  return lines.join('\n');
};

export const formatMilitary = (military) => {
  if (!military || typeof military !== 'object' || Array.isArray(military)) return null;
  const units = [
    ['soldiers', 'Soldiers'],
    ['tanks', 'Tanks'],
    ['aircraft', 'Aircraft'],
    ['ships', 'Ships'],
    ['spies', 'Spies'],
    ['missiles', 'Missiles'],
    ['nukes', 'Nukes'],
  ].filter(([key]) => isPresent(military[key]));
  if (!units.length) return null;
  return units.map(([key, label]) => `**${label}:** ${formatNumber(military[key], { maximumFractionDigits: 0 })}`).join(' · ');
};

export const nationUrl = (nation = {}) => safeUrl(nation.nation_url ?? nation.url ?? nation.links?.nation)
  ?? (isPresent(nation.id ?? nation.nation_id)
    ? `https://politicsandwar.com/nation/id=${encodeURIComponent(nation.id ?? nation.nation_id)}`
    : null);

export const allianceUrl = (alliance = {}) => safeUrl(alliance.alliance_url ?? alliance.url ?? alliance.links?.alliance)
  ?? (isPresent(alliance.alliance_id ?? alliance.id)
    ? `https://politicsandwar.com/alliance/id=${encodeURIComponent(alliance.alliance_id ?? alliance.id)}`
    : null);

const nationName = (nation = {}) => nation.nation_name ?? nation.name
  ?? (isPresent(nation.id ?? nation.nation_id) ? `Nation #${nation.id ?? nation.nation_id}` : 'Unknown nation');

const linkedNation = (nation = {}) => markdownLink(nationName(nation), nationUrl(nation));

const allianceLabel = (item = {}) => {
  const alliance = item.alliance && typeof item.alliance === 'object' ? item.alliance : item;
  const name = alliance.name ?? item.alliance_name;
  if (!isPresent(name)) return 'No alliance';
  return markdownLink(name, allianceUrl({
    ...alliance,
    alliance_id: alliance.id ?? item.alliance_id,
    alliance_url: alliance.url ?? item.alliance_url,
  }));
};

const compactParts = (parts) => parts.filter(isPresent).join(' · ');

const field = (name, lines, inline = false) => ({
  name: truncate(cleanText(name).replace(/\s+/g, ' '), 256),
  value: truncate(Array.isArray(lines) ? lines.filter(isPresent).join('\n') : lines, 1024),
  inline,
});

const renderRaid = (item, index) => {
  const name = nationName(item);
  const leader = isPresent(item.leader_name) ? ` — ${escapeMarkdown(item.leader_name)}` : '';
  const heading = `${index + 1}. ${markdownLink(name, nationUrl(item))}${leader}`;
  const military = formatMilitary(item.military ?? item.military_units);
  const loot = item.loot_values ?? item.loot ?? item.estimated_resources;
  const lines = [
    `**Alliance:** ${allianceLabel(item)}`,
    compactParts([
      isPresent(item.cities) ? `**Cities:** ${formatNumber(item.cities, { maximumFractionDigits: 0 })}` : null,
      isPresent(item.score) ? `**Score:** ${formatNumber(item.score)}` : null,
      isPresent(item.defensive_wars) ? `**Defensive wars:** ${formatNumber(item.defensive_wars, { maximumFractionDigits: 0 })}/3` : null,
    ]),
    compactParts([
      isPresent(item.estimated_value) ? `**Estimated loot:** ${formatMoney(item.estimated_value)}` : null,
      isPresent(item.last_beige_value ?? item.last_beige) ? `**Last beige:** ${formatMoney(item.last_beige_value ?? item.last_beige)}` : null,
    ]),
    isPresent(item.last_active) ? `**Last active:** ${formatDiscordTime(item.last_active)}` : null,
    military ? `**Military**\n${military}` : null,
    loot && typeof loot === 'object' ? `**Loot estimate**\n${formatResources(loot)}` : null,
  ];
  return field(heading, lines);
};

const renderAccount = (item, index) => {
  const status = item.frozen ? '○ Frozen' : '● Available';
  return field(`${index + 1}. ${escapeMarkdown(item.name ?? item.label ?? `Account #${item.id ?? index + 1}`)}`, [
    status,
    formatResources(item.resources ?? item.balances),
  ]);
};

const renderTransaction = (item, index) => {
  const direction = item.direction === 'out' ? '↗ Outgoing' : item.direction === 'in' ? '↙ Incoming' : null;
  const type = titleCase(item.type ?? 'Transaction');
  const identifier = isPresent(item.id) ? ` #${item.id}` : ` ${index + 1}`;
  return field(`${direction ? `${direction} · ` : ''}${type}${identifier}`, [
    statusLabel(item.status),
    formatResources(item.resources),
    item.pending_reason ? `**Reason:** ${escapeMarkdown(item.pending_reason)}` : null,
    item.created_at ? `**Created:** ${formatDiscordTime(item.created_at)}` : null,
  ]);
};

const requestTitle = (item, index) => `${titleCase(item.type ?? 'Request')} #${item.id ?? index + 1}`;

const renderRequest = (item, index, context) => {
  const deepLink = resolveDeepLink(context.baseUrl, item.deep_link_path ?? item.url);
  const title = markdownLink(requestTitle(item, index), deepLink);
  return field(title, [
    statusLabel(item.status),
    isPresent(item.nation_id) ? `**Nation:** ${markdownLink(`Nation #${item.nation_id}`, nationUrl({ id: item.nation_id }))}` : null,
    item.created_at ? `**Submitted:** ${formatDiscordTime(item.created_at)}` : null,
    item.updated_at ? `**Updated:** ${formatDiscordTime(item.updated_at)}` : null,
  ]);
};

const renderGrantProgram = (item, index, context) => {
  const deepLink = resolveDeepLink(context.baseUrl, item.deep_link_path ?? item.url);
  const title = markdownLink(item.name ?? `Grant program ${index + 1}`, deepLink);
  const eligibility = item.eligible === true ? '✓ Eligible' : item.eligible === false ? '× Not eligible' : null;
  const summary = Array.isArray(item.eligibility_summary)
    ? item.eligibility_summary.map((entry) => cleanText(entry)).slice(0, 3).join(' · ')
    : cleanText(item.eligibility_summary, '');
  return field(`${index + 1}. ${title}`, [
    compactParts([eligibility, item.one_time ? 'One-time' : 'Repeatable']),
    item.description ? escapeMarkdown(truncate(item.description, 350)) : null,
    summary ? `**Eligibility:** ${escapeMarkdown(summary)}` : null,
  ]);
};

const renderLoan = (item, index, context) => {
  const deepLink = resolveDeepLink(context.baseUrl, item.deep_link_path ?? item.url);
  return field(markdownLink(`Loan #${item.id ?? index + 1}`, deepLink), [
    statusLabel(item.status),
    compactParts([
      isPresent(item.amount) ? `**Original:** ${formatMoney(item.amount)}` : null,
      isPresent(item.remaining_balance) ? `**Remaining:** ${formatMoney(item.remaining_balance)}` : null,
      isPresent(item.current_amount_due) ? `**Due now:** ${formatMoney(item.current_amount_due)}` : null,
    ]),
    compactParts([
      isPresent(item.interest_rate) ? `**Interest:** ${formatPercent(item.interest_rate)}` : null,
      isPresent(item.term_weeks) ? `**Term:** ${formatNumber(item.term_weeks, { maximumFractionDigits: 0 })} weeks` : null,
      isPresent(item.scheduled_weekly_payment) ? `**Weekly:** ${formatMoney(item.scheduled_weekly_payment)}` : null,
    ]),
    item.next_due_date ? `**Next due:** ${formatDiscordTime(item.next_due_date, 'D')}` : null,
  ]);
};

const renderApplication = (item, index, context) => {
  const deepLink = resolveDeepLink(context.baseUrl, item.deep_link_path ?? item.url);
  const identity = item.leader_name ?? item.discord_username ?? `Application #${item.id ?? index + 1}`;
  return field(markdownLink(identity, deepLink), [
    compactParts([statusLabel(item.status), isPresent(item.id) ? `**ID:** ${item.id}` : null]),
    isPresent(item.nation_id) ? `**Nation:** ${markdownLink(`Nation #${item.nation_id}`, nationUrl({ id: item.nation_id }))}` : null,
    item.discord_username ? `**Discord:** ${escapeMarkdown(item.discord_username)}` : null,
    item.created_at ? `**Submitted:** ${formatDiscordTime(item.created_at)}` : null,
    item.denial_reason ? `**Denial reason:** ${escapeMarkdown(item.denial_reason)}` : null,
  ]);
};

const renderWar = (item, index) => {
  const attacker = item.attacker ?? {};
  const defender = item.defender ?? item.target ?? {};
  const url = item.war_url ?? item.url;
  const warType = item.war_type ?? item.type;
  const heading = markdownLink(`War #${item.id ?? index + 1}`, url);
  return field(heading, [
    `${linkedNation(attacker)} **vs** ${linkedNation(defender)}`,
    compactParts([
      item.role ? `**Your side:** ${titleCase(item.role)}` : null,
      warType ? `**Type:** ${titleCase(warType)}` : null,
      isPresent(item.turns_left) ? `**Turns left:** ${formatNumber(item.turns_left, { maximumFractionDigits: 0 })}` : null,
      statusLabel(item.status),
    ]),
  ]);
};

const renderWarAssignment = (item, index) => {
  const target = item.target ?? {};
  const response = item.response?.response ?? item.response;
  return field(`${index + 1}. ${linkedNation(target)}`, [
    compactParts([statusLabel(item.status), item.type ? `**Type:** ${titleCase(item.type)}` : null]),
    isPresent(target.leader_name) ? `**Leader:** ${escapeMarkdown(target.leader_name)}` : null,
    item.source?.name ? `**Operation:** ${escapeMarkdown(item.source.name)}` : null,
    response ? `**Your response:** ${titleCase(response)}` : '**Your response:** Awaiting response',
    item.response?.reason ? `**Reason:** ${escapeMarkdown(item.response.reason)}` : null,
  ]);
};

const renderWarCounter = (item, index, context) => {
  const target = item.target ?? {};
  const deepLink = resolveDeepLink(context.baseUrl, item.deep_link_path ?? item.url);
  return field(markdownLink(`Counter #${item.id ?? index + 1}`, deepLink), [
    `${linkedNation(target)}${target.leader_name ? ` — ${escapeMarkdown(target.leader_name)}` : ''}`,
    compactParts([
      statusLabel(item.status),
      item.type ? `**Declaration:** ${titleCase(item.type)}` : null,
      isPresent(item.team_size) ? `**Team:** ${formatNumber(item.team_size, { maximumFractionDigits: 0 })}` : null,
    ]),
  ]);
};

const renderSpy = (item, index) => {
  const target = item.target ?? {};
  return field(`${index + 1}. ${titleCase(item.operation ?? 'Spy operation')} → ${linkedNation(target)}`, [
    compactParts([
      statusLabel(item.status),
      isPresent(item.calculated_odds) ? `**Odds:** ${formatPercent(item.calculated_odds)}` : null,
      isPresent(item.safety_level) ? `**Safety:** ${formatNumber(item.safety_level, { maximumFractionDigits: 0 })}` : null,
    ]),
    target.leader_name ? `**Leader:** ${escapeMarkdown(target.leader_name)}` : null,
    item.campaign?.name ? `**Campaign:** ${escapeMarkdown(item.campaign.name)}${isPresent(item.campaign.round) ? ` · Round ${formatNumber(item.campaign.round, { maximumFractionDigits: 0 })}` : ''}` : null,
    safeUrl(item.espionage_url) ? `[Open espionage screen](${safeUrl(item.espionage_url)})` : null,
  ]);
};

const renderAudit = (item, index) => field(`${index + 1}. ${statusLabel(item.priority) ?? 'i Info'} · ${escapeMarkdown(item.name ?? 'Audit finding')}${isPresent(item.id) ? ` · #${item.id}` : ''}`, [
  item.description ? escapeMarkdown(item.description) : null,
  compactParts([
    item.target ? `**Target:** ${escapeMarkdown(item.target)}` : null,
    item.target_type ? `**Scope:** ${titleCase(item.target_type)}` : null,
  ]),
  item.due_at ? `**Due:** ${formatDiscordTime(item.due_at)}` : null,
  item.snoozed_until ? `**Snoozed until:** ${formatDiscordTime(item.snoozed_until)}` : null,
  item.first_detected_at ? `**First detected:** ${formatDiscordTime(item.first_detected_at)}` : null,
]);

const renderBlockade = (item, index, context) => {
  const deepLink = resolveDeepLink(context.baseUrl, item.deep_link_path ?? item.url);
  const requester = item.requester ?? {};
  const blockader = item.blockader ?? {};
  const claimer = item.claimer ?? null;
  return field(markdownLink(item.label ?? `Relief request #${item.id ?? index + 1}`, deepLink), [
    statusLabel(item.status),
    `${markdownLink(requester.name ?? `Nation #${requester.id ?? '?'}`, nationUrl(requester))} needs relief from ${markdownLink(blockader.name ?? `Nation #${blockader.id ?? '?'}`, nationUrl(blockader))}`,
    claimer ? `**Claimed by:** ${markdownLink(claimer.name ?? `Nation #${claimer.id}`, nationUrl(claimer))}` : '**Claimed by:** Unassigned',
    item.deadline_at ? `**Deadline:** ${formatDiscordTime(item.deadline_at)}` : null,
    isPresent(item.war_id) ? `[Open war](https://politicsandwar.com/nation/war/timeline/war=${encodeURIComponent(item.war_id)})` : null,
  ]);
};

const renderAlert = (item, index, context) => {
  const deepLink = resolveDeepLink(context.baseUrl, item.deep_link_path ?? item.url);
  return field(markdownLink(item.name ?? `Alert #${item.id ?? index + 1}`, deepLink), [
    compactParts([item.active === false ? '○ Paused' : '● Active', item.type_label ?? (item.type ? titleCase(item.type) : null)]),
    item.condition ? `**When:** ${escapeMarkdown(item.condition)}` : null,
    isPresent(item.cooldown_minutes) ? `**Cooldown:** ${formatNumber(item.cooldown_minutes, { maximumFractionDigits: 0 })} minutes` : null,
    item.last_triggered_at ? `**Last triggered:** ${formatDiscordTime(item.last_triggered_at)}` : null,
    item.expires_at ? `**Expires:** ${formatDiscordTime(item.expires_at)}` : null,
  ]);
};

const GENERIC_KEYS = [
  'status', 'type', 'account_name', 'amount', 'remaining_balance', 'eligible', 'cities', 'score',
  'estimated_value', 'turns_left', 'created_at', 'updated_at', 'target', 'reason',
];

const genericValue = (key, value) => {
  if (key.includes('at') || key.includes('date')) return formatDiscordTime(value);
  if (key.includes('amount') || key.includes('balance') || key.includes('value')) return formatMoney(value);
  if (key === 'status') return statusLabel(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return formatNumber(value);
  if (value && typeof value === 'object') return escapeMarkdown(value.label ?? value.name ?? value.nation_name ?? value.leader_name ?? value.status ?? 'Available');
  return escapeMarkdown(value);
};

const renderGeneric = (item, index) => {
  if (typeof item === 'string') return field(`${index + 1}. Item`, escapeMarkdown(item));
  const heading = item?.label ?? item?.name ?? item?.title ?? item?.nation_name ?? `Item ${index + 1}`;
  const details = GENERIC_KEYS
    .filter((key) => isPresent(item?.[key]))
    .slice(0, 6)
    .map((key) => `**${titleCase(key)}:** ${genericValue(key, item[key])}`);
  if (item?.resources && typeof item.resources === 'object') details.push(formatResources(item.resources));
  return field(`${index + 1}. ${escapeMarkdown(heading)}`, details.length ? details : 'No additional details.');
};

const RENDERERS = Object.freeze({
  account: renderAccount,
  alert: renderAlert,
  application: renderApplication,
  audit: renderAudit,
  blockade: renderBlockade,
  'grant-program': renderGrantProgram,
  loan: renderLoan,
  raid: renderRaid,
  request: renderRequest,
  spy: renderSpy,
  transaction: renderTransaction,
  war: renderWar,
  'war-assignment': renderWarAssignment,
  'war-counter': renderWarCounter,
  generic: renderGeneric,
});

export const variantConfig = (variant = 'generic') => VARIANTS[variant] ?? VARIANTS.generic;

export const renderCollectionItem = (variant, item, index, context = {}) => {
  const renderer = RENDERERS[variant] ?? RENDERERS.generic;
  return renderer(item, index, context);
};

export const pluralize = (count, noun) => `${noun}${Number(count) === 1 ? '' : 's'}`;

export const buildEmbed = ({
  title,
  description,
  tone = 'info',
  color,
  fields = [],
  footer,
  url,
  timestamp = false,
}) => {
  const safeTitle = truncate(cleanText(title).replace(/\s+/g, ' '), 256);
  const embed = new EmbedBuilder()
    .setColor(color ?? UI_COLORS[tone] ?? UI_COLORS.info)
    .setTitle(safeTitle);
  let remainingCharacters = 6000 - safeTitle.length;
  const safeDescription = isPresent(description)
    ? truncate(description, Math.min(4096, remainingCharacters))
    : null;
  if (safeDescription) {
    embed.setDescription(safeDescription);
    remainingCharacters -= safeDescription.length;
  }
  const validFields = [];
  for (const entry of fields.filter((candidate) => candidate && isPresent(candidate.name) && isPresent(candidate.value)).slice(0, 25)) {
    const safeName = truncate(cleanText(entry.name).replace(/\s+/g, ' '), Math.min(256, remainingCharacters));
    const valueBudget = Math.min(1024, remainingCharacters - safeName.length);
    if (valueBudget < 1) break;
    const safeValue = truncate(entry.value, valueBudget);
    validFields.push({ name: safeName, value: safeValue, inline: Boolean(entry.inline) });
    remainingCharacters -= safeName.length + safeValue.length;
    if (remainingCharacters < 2) break;
  }
  if (validFields.length) embed.addFields(validFields);
  if (isPresent(footer) && remainingCharacters > 0) {
    embed.setFooter({ text: truncate(footer, Math.min(2048, remainingCharacters)) });
  }
  const href = safeUrl(url);
  if (href) embed.setURL(href);
  if (timestamp) embed.setTimestamp();
  return embed;
};

export const statusMessage = (options = {}) => ({
  embeds: [buildEmbed(options)],
  components: options.components ?? [],
});
