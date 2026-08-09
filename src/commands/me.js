import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
} from 'discord.js';
import { actorFromInteraction, deferEphemeral, replyError } from '../utils/commandSupport.js';
import {
  buildEmbed,
  cleanText,
  escapeMarkdown,
  formatDiscordTime,
  markdownLink,
  resolveDeepLink,
  safeUrl,
  truncate,
} from '../utils/discordUi.js';

const STATES = Object.freeze({
  unlinked: 'Not linked',
  ambiguous: 'Needs attention',
  disabled: 'Disabled',
  nexus_unverified: 'Verification needed',
  no_nation: 'Nation needed',
  mfa_required: 'MFA required',
  ready: 'Ready',
  installation_unavailable: 'Installation unavailable',
});

// This is a presentation allowlist, not an authorization list. Nexus remains authoritative.
const LINK_LABELS = Object.freeze({
  account: 'Open Nexus account',
  alliance: 'Open alliance profile',
  application: 'Open application',
  audit: 'Open audit center',
  help: 'Open Nexus help',
  me: 'Open Nexus profile',
  nation: 'Open nation profile',
  profile: 'Open Nexus profile',
  settings: 'Open Nexus settings',
  verification: 'Open verification',
  work: 'Open open work',
});

const HIDDEN_WORK_TYPES = /(?:balance|finance|loan|military|spy|transaction|war)/i;
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonNegativeInteger = (value) => Number.isInteger(value) && value >= 0;
const isPositiveInteger = (value) => Number.isInteger(value) && value > 0;

const invalidSummaryError = () => Object.assign(
  new Error('Nexus returned an invalid account summary.'),
  { code: 'VALIDATION_ERROR' },
);

const cleanString = (value) => {
  if (typeof value !== 'string') return null;
  const cleaned = cleanText(value, '');
  return cleaned || null;
};

const requiredString = (object, key) => {
  const value = cleanString(object[key]);
  if (!value) throw invalidSummaryError();
  return value;
};

const requiredPositiveInteger = (object, key) => {
  if (!isPositiveInteger(object[key])) throw invalidSummaryError();
  return object[key];
};

const requireKeys = (object, keys) => {
  if (!isRecord(object) || keys.some((key) => !hasOwn(object, key))) throw invalidSummaryError();
};

const selectedPayload = (response) => {
  if (!isRecord(response)) throw invalidSummaryError();
  if (hasOwn(response, 'me')) return response.me;
  if (hasOwn(response, 'data')) return response.data;
  return response;
};

const sameOriginLink = (baseUrl, value) => {
  const base = safeUrl(baseUrl);
  if (!base || typeof value !== 'string' || !value.trim()) return null;

  const resolved = resolveDeepLink(base, value.trim());
  const candidate = safeUrl(resolved);
  if (!candidate) return null;

  try {
    return new URL(candidate).origin === new URL(base).origin ? candidate : null;
  } catch {
    return null;
  }
};

const requiredSameOriginLink = (baseUrl, object, key) => {
  const value = requiredString(object, key);
  if (!sameOriginLink(baseUrl, value)) throw invalidSummaryError();
  return value;
};

const validateEntity = (baseUrl, value, keys) => {
  requireKeys(value, keys);
  requiredPositiveInteger(value, 'id');
  requiredString(value, 'name');
  if (keys.includes('leader_name')) requiredString(value, 'leader_name');
  requiredSameOriginLink(baseUrl, value, 'deep_link_path');
};

const validateIdentity = (baseUrl, value) => {
  const keys = ['display_name', 'discord_username', 'link_state', 'linked_at', 'deep_link_path'];
  requireKeys(value, keys);
  keys.slice(0, -1).forEach((key) => requiredString(value, key));
  requiredSameOriginLink(baseUrl, value, 'deep_link_path');
};

const validateCapabilities = (value) => {
  requireKeys(value, ['items', 'revision']);
  if (!Array.isArray(value.items) || value.items.length > 50) throw invalidSummaryError();
  if (!isPositiveInteger(value.revision)) throw invalidSummaryError();
  for (const item of value.items) {
    requireKeys(item, ['key', 'label']);
    requiredString(item, 'key');
    requiredString(item, 'label');
  }
};

const validateOpenWork = (value) => {
  requireKeys(value, ['total', 'by_type', 'complete', 'generated_at']);
  if (!isNonNegativeInteger(value.total) || typeof value.complete !== 'boolean') throw invalidSummaryError();
  if (!isRecord(value.by_type)) throw invalidSummaryError();
  for (const count of Object.values(value.by_type)) {
    if (!isNonNegativeInteger(count)) throw invalidSummaryError();
  }
  requiredString(value, 'generated_at');
};

const validateProfileSync = (value) => {
  requireKeys(value, ['state', 'label', 'checked_at', 'issues']);
  requiredString(value, 'state');
  requiredString(value, 'label');
  requiredString(value, 'checked_at');
  if (!Array.isArray(value.issues) || value.issues.length > 50
    || value.issues.some((issue) => cleanString(issue) === null)) throw invalidSummaryError();
};

const validateFreshness = (value) => {
  requireKeys(value, ['state', 'generated_at', 'source_updated_at']);
  requiredString(value, 'state');
  requiredString(value, 'generated_at');
  requiredString(value, 'source_updated_at');
};

const validateLinks = (baseUrl, value) => {
  if (!isRecord(value)) throw invalidSummaryError();
  const entries = Object.entries(value);
  if (entries.length < 1 || entries.length > 10) throw invalidSummaryError();
  for (const [key, link] of entries) {
    if (!hasOwn(LINK_LABELS, key) || !sameOriginLink(baseUrl, link)) throw invalidSummaryError();
  }
};

const validateUserAction = (baseUrl, value) => {
  if (value === undefined || value === null) return;
  requireKeys(value, ['label', 'deep_link_path']);
  requiredString(value, 'label');
  requiredSameOriginLink(baseUrl, value, 'deep_link_path');
};

const validatePayload = (response, baseUrl) => {
  const payload = selectedPayload(response);
  if (!isRecord(payload) || payload.contract_version !== 1) throw invalidSummaryError();

  const state = payload.state;
  if (typeof state !== 'string' || !hasOwn(STATES, state)) throw invalidSummaryError();
  requiredString(payload, 'message');

  if (state !== 'ready') {
    validateUserAction(baseUrl, payload.user_action);
    return { payload, state };
  }

  validateIdentity(baseUrl, payload.identity);
  validateEntity(baseUrl, payload.nation, ['id', 'name', 'leader_name', 'deep_link_path']);
  if (payload.alliance !== null) validateEntity(baseUrl, payload.alliance, ['id', 'name', 'deep_link_path']);
  validateCapabilities(payload.capabilities);
  validateOpenWork(payload.open_work);
  validateProfileSync(payload.profile_sync);
  validateFreshness(payload.freshness);
  validateLinks(baseUrl, payload.links);
  return { payload, state };
};

const safeText = (value, maxLength = 500, fallback = '—') => escapeMarkdown(
  truncate(value, maxLength, fallback),
).replace(/@(?=(?:everyone|here)\b|[!&]?\d{17,20}>)/gi, '@\u200b');

const renderLink = (baseUrl, label, value) => {
  const url = sameOriginLink(baseUrl, value);
  return url ? markdownLink(label, url) : 'Link unavailable';
};

const renderIdentity = (baseUrl, identity) => [
  `**Name:** ${safeText(identity.display_name)}`,
  `**Discord:** ${safeText(identity.discord_username)}`,
  `**Link state:** ${safeText(identity.link_state)}`,
  `**Linked:** ${formatDiscordTime(identity.linked_at)}`,
  renderLink(baseUrl, 'Open profile in Nexus', identity.deep_link_path),
].join('\n');

const renderEntity = (baseUrl, entity, kind) => {
  if (entity === null && kind === 'alliance') return 'No alliance';
  const lines = [`**#${entity.id} · ${safeText(entity.name)}**`];
  if (kind === 'nation') lines.push(`Leader: ${safeText(entity.leader_name)}`);
  lines.push(renderLink(baseUrl, `Open ${kind} profile in Nexus`, entity.deep_link_path));
  return lines.join('\n');
};

const renderCapabilities = (capabilities) => {
  const items = capabilities.items.map((item) => `${safeText(item.key)}: ${safeText(item.label)}`);
  return [
    items.length ? items.slice(0, 12).join('\n') : 'No capabilities reported.',
    `Revision: ${safeText(capabilities.revision)}`,
  ].join('\n');
};

const renderOpenWork = (openWork) => {
  const byType = Object.entries(openWork.by_type)
    .filter(([key]) => !HIDDEN_WORK_TYPES.test(key))
    .slice(0, 12)
    .map(([key, count]) => `${safeText(key)}: ${count}`);
  return [
    `Total: ${openWork.total}`,
    byType.length ? `By type: ${byType.join(', ')}` : null,
    `Complete: ${openWork.complete ? 'yes' : 'no'}`,
    `Generated: ${formatDiscordTime(openWork.generated_at)}`,
  ].filter(Boolean).join('\n');
};

const renderProfileSync = (profileSync) => [
  `**${safeText(profileSync.state)}** · ${safeText(profileSync.label)}`,
  `Checked: ${formatDiscordTime(profileSync.checked_at)}`,
  `Issues: ${profileSync.issues.length}`,
].join('\n');

const renderFreshness = (freshness) => [
  `**${safeText(freshness.state)}**`,
  `Generated: ${formatDiscordTime(freshness.generated_at)}`,
  `Source updated: ${formatDiscordTime(freshness.source_updated_at)}`,
].join('\n');

const renderLinks = (baseUrl, links) => Object.entries(links)
  .map(([key, value]) => markdownLink(LINK_LABELS[key], sameOriginLink(baseUrl, value)))
  .join('\n');

const linkButtons = (baseUrl, links) => {
  const buttons = Object.entries(links)
    .map(([key, value]) => {
      const url = sameOriginLink(baseUrl, value);
      if (!url || !hasOwn(LINK_LABELS, key)) return null;
      return new ButtonBuilder()
        .setLabel(truncate(LINK_LABELS[key], 80))
        .setStyle(ButtonStyle.Link)
        .setURL(url);
    })
    .filter(Boolean)
    .slice(0, 5);
  return buttons.length ? [new ActionRowBuilder().addComponents(buttons)] : [];
};

const userActionButtons = (baseUrl, action) => {
  if (!action) return [];
  const url = sameOriginLink(baseUrl, action.deep_link_path);
  if (!url) return [];
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel(truncate(action.label, 80))
      .setStyle(ButtonStyle.Link)
      .setURL(url),
  )];
};

const nonReadyMessage = (payload, state, baseUrl) => {
  const fields = [{ name: 'Status', value: safeText(STATES[state]) }];
  if (payload.user_action) {
    fields.push({
      name: 'Next step',
      value: `${safeText(payload.user_action.label)}\n${renderLink(
        baseUrl,
        'Continue in Nexus',
        payload.user_action.deep_link_path,
      )}`,
    });
  }
  const actions = userActionButtons(baseUrl, payload.user_action);
  return {
    embeds: [buildEmbed({
      title: `Nexus Account · ${STATES[state]}`,
      description: safeText(payload.message, 1_000),
      tone: state === 'disabled' ? 'danger' : 'warning',
      fields,
    })],
    components: actions,
    allowedMentions: { parse: [] },
  };
};

const readyMessage = (payload, baseUrl) => ({
  embeds: [buildEmbed({
    title: 'Nexus Account',
    description: safeText(payload.message, 1_000),
    tone: 'success',
    fields: [
      { name: 'Identity', value: renderIdentity(baseUrl, payload.identity) },
      { name: 'Nation', value: renderEntity(baseUrl, payload.nation, 'nation') },
      { name: 'Alliance', value: renderEntity(baseUrl, payload.alliance, 'alliance') },
      { name: 'Capabilities', value: renderCapabilities(payload.capabilities) },
      { name: 'Open work', value: renderOpenWork(payload.open_work) },
      { name: 'Profile sync', value: renderProfileSync(payload.profile_sync) },
      { name: 'Freshness', value: renderFreshness(payload.freshness) },
      { name: 'Nexus links', value: renderLinks(baseUrl, payload.links) },
    ],
  })],
  components: linkButtons(baseUrl, payload.links),
  allowedMentions: { parse: [] },
});

export const data = new SlashCommandBuilder()
  .setName('me')
  .setDescription('View your Nexus account and link status.')
  .setDMPermission(false);

export const help = Object.freeze({
  audience: 'Members',
  topic: Object.freeze(['member']),
  examples: Object.freeze(['/me']),
  related: Object.freeze(['verify', 'accounts', 'audit', 'help']),
});

export const execute = async (interaction, context) => {
  await deferEphemeral(interaction);
  try {
    const response = await context.apiService.getMySummary(actorFromInteraction(interaction, 'me'));
    const { payload, state } = validatePayload(response, context.apiService.baseUrl);
    await interaction.editReply(state === 'ready'
      ? readyMessage(payload, context.apiService.baseUrl)
      : nonReadyMessage(payload, state, context.apiService.baseUrl));
  } catch (error) {
    await replyError(interaction, error);
  }
};
