import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
} from 'discord.js';
import { isDiscordSnowflake } from '../utils/boundaryValidators.js';
import { actorFromInteraction, deferEphemeral, replyError } from '../utils/commandSupport.js';
import {
  buildEmbed,
  cleanText,
  escapeMarkdown,
  formatDiscordTime,
  markdownLink,
  resolveDeepLink,
  safeUrl,
  statusMessage,
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
const ACTIONABLE_PROFILE_SYNC_STATES = new Set(['available', 'attention', 'synced']);
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

const profileSyncButton = (profileSync, interaction, sessions) => {
  if (!sessions || !ACTIONABLE_PROFILE_SYNC_STATES.has(profileSync.state)) return [];
  const customId = sessions.create({
    commandName: 'me',
    userId: interaction.user.id,
    event: 'profile-sync-preview',
    oneShot: true,
  });
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(customId)
      .setLabel(profileSync.state === 'attention' ? 'Retry profile sync' : 'Sync profile')
      .setStyle(ButtonStyle.Primary),
  )];
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

const readyMessage = (payload, baseUrl, interaction, sessions) => ({
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
  components: [
    ...profileSyncButton(payload.profile_sync, interaction, sessions),
    ...linkButtons(baseUrl, payload.links),
  ],
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
      ? readyMessage(payload, context.apiService.baseUrl, interaction, context.sessions)
      : nonReadyMessage(payload, state, context.apiService.baseUrl));
  } catch (error) {
    await replyError(interaction, error);
  }
};

const observedMemberProfile = async (interaction) => {
  if (!interaction.guild || !isDiscordSnowflake(interaction.guildId)
    || !isDiscordSnowflake(interaction.user?.id)) {
    throw new TypeError('Profile synchronization must be used inside the connected Discord server.');
  }
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const memberId = `${member?.id ?? ''}`.trim();
  const memberGuildId = `${member?.guildId ?? member?.guild?.id ?? ''}`.trim();
  if (memberId !== interaction.user.id || memberGuildId !== interaction.guildId) {
    throw new TypeError('Discord returned the wrong member while checking your profile.');
  }

  const cache = member?.roles?.cache;
  const roles = typeof cache?.values === 'function'
    ? Array.from(cache.values()).map((role) => role?.id)
    : Array.isArray(member?.roles)
      ? member.roles
      : Array.isArray(member?._roles)
        ? member._roles
        : [];
  const roleIds = [...new Set(roles
    .map((roleId) => `${roleId ?? ''}`.trim())
    .filter((roleId) => roleId !== interaction.guildId && isDiscordSnowflake(roleId)))]
    .sort();
  if (roleIds.length > 100) {
    throw new TypeError('This member has too many Discord roles for safe self-service synchronization.');
  }

  return {
    nickname: typeof member.nickname === 'string' ? member.nickname : null,
    role_ids: roleIds,
  };
};

const previewProfileSync = async (interaction, context) => {
  const observed = await observedMemberProfile(interaction);
  const preview = await context.apiService.previewMemberProfileSync(
    actorFromInteraction(interaction, 'me'),
    { observed },
  );
  const intentId = `${preview?.intent?.id ?? ''}`;
  if (!/^[a-zA-Z0-9]{64}$/.test(intentId)) {
    throw new TypeError('Nexus returned an invalid profile synchronization confirmation token.');
  }
  const confirmId = context.sessions.create({
    commandName: 'me',
    userId: interaction.user.id,
    event: 'profile-sync-confirm',
    state: { intentId },
    oneShot: true,
  });
  const cancelId = context.sessions.create({
    commandName: 'me',
    userId: interaction.user.id,
    event: 'profile-sync-cancel',
    oneShot: true,
  });
  const summary = preview?.summary ?? {};
  const nickname = summary?.nickname ?? {};
  const roles = summary?.roles ?? {};
  const warnings = Array.isArray(preview?.warnings)
    ? preview.warnings.filter((warning) => typeof warning === 'string' && warning.trim() !== '')
    : [];

  await interaction.editReply({
    embeds: [buildEmbed({
      title: 'Review Discord Profile Sync',
      tone: 'warning',
      description: truncate(
        summary.description ?? 'Nexus calculated the Discord profile changes. Confirm to apply them.',
        1_200,
      ),
      fields: [
        {
          name: 'Nickname',
          value: nickname.will_change === true
            ? `${safeText(nickname.current ?? 'No server nickname')} → ${safeText(nickname.desired)}`
            : `No change · ${safeText(nickname.desired ?? nickname.current)}`,
          inline: false,
        },
        { name: 'Managed roles to add', value: `${Number(roles.add_count) || 0}`, inline: true },
        { name: 'Managed roles to remove', value: `${Number(roles.remove_count) || 0}`, inline: true },
        { name: 'Managed role scope', value: `${Number(roles.managed_count) || 0}`, inline: true },
        preview?.intent?.expires_at
          ? { name: 'Confirmation expires', value: formatDiscordTime(preview.intent.expires_at), inline: true }
          : null,
        warnings.length > 0
          ? { name: 'Nexus guidance', value: safeText(warnings.join('\n'), 1_000), inline: false }
          : null,
      ],
      footer: 'Nexus will revalidate your membership, policy, installation, and permissions when you confirm.',
    })],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(confirmId).setLabel('Confirm profile sync').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(cancelId).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    )],
    allowedMentions: { parse: [] },
  });
};

export const button = async (interaction, context) => {
  await interaction.deferUpdate();
  try {
    if (!context.apiService || !context.sessions) {
      throw new TypeError('The Nexus profile synchronization service is unavailable.');
    }
    if (context.session?.event === 'profile-sync-preview') {
      await previewProfileSync(interaction, context);
      return;
    }
    if (context.session?.event === 'profile-sync-cancel') {
      await interaction.editReply(statusMessage({
        title: 'Profile Sync Canceled',
        tone: 'neutral',
        description: 'No nickname or role changes were requested.',
      }));
      return;
    }
    if (context.session?.event !== 'profile-sync-confirm') {
      throw new TypeError('This profile synchronization control is invalid or expired.');
    }
    const intentId = `${context.session?.state?.intentId ?? ''}`;
    if (!/^[a-zA-Z0-9]{64}$/.test(intentId)) {
      throw new TypeError('This profile synchronization confirmation is invalid or expired.');
    }
    const result = await context.apiService.confirmMemberProfileSync(
      actorFromInteraction(interaction, 'me'),
      { intent_id: intentId },
    );
    if (result?.queued !== true || !result?.queue?.id || result?.profile_sync?.state !== 'pending') {
      throw new TypeError('Nexus returned an invalid profile synchronization result.');
    }
    await interaction.editReply(statusMessage({
      title: 'Profile Sync Queued',
      tone: 'success',
      description: 'Nexus queued the exact nickname and managed-role changes. Run /me again to check the result.',
      fields: [
        result.queue.created_at
          ? { name: 'Queued', value: formatDiscordTime(result.queue.created_at), inline: true }
          : null,
        { name: 'Status', value: safeText(result.profile_sync.label ?? 'Pending'), inline: true },
      ],
      footer: 'Unmanaged Discord roles are never removed by profile synchronization.',
    }));
  } catch (error) {
    context.logger?.warn?.('Nexus rejected /me profile synchronization', {
      command: 'me',
      guildId: interaction.guildId,
      userId: interaction.user.id,
      event: context.session?.event ?? null,
      errorCode: error?.code ?? null,
      status: error?.status ?? null,
    });
    await replyError(interaction, error, 'Profile Synchronization Failed');
  }
};
