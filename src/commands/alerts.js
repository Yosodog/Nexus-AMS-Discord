import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, StringSelectMenuBuilder,
} from 'discord.js';
import {
  actorFromInteraction, collectionMessage, deferEphemeral, normalizeCollection, replyError,
} from '../utils/commandSupport.js';
import {
  escapeMarkdown, formatDiscordTime, formatNumber, resolveDeepLink, statusMessage, titleCase, truncate,
} from '../utils/discordUi.js';

const NATION_EVENTS = [
  ['Alliance changed', 'nation.alliance.changed'],
  ['Entered vacation mode', 'nation.vacation.entered'],
  ['Exited vacation mode', 'nation.vacation.exited'],
  ['Exited beige', 'nation.beige.exited'],
  ['City count changed', 'nation.city_count.changed'],
  ['Active war count changed', 'nation.active_wars.changed'],
];
const ALLIANCE_EVENTS = [
  ['Membership changed', 'alliance.membership.changed'],
  ['Treaty changed', 'alliance.treaty.changed'],
];
const RESOURCES = ['coal', 'oil', 'uranium', 'iron', 'bauxite', 'lead', 'gasoline', 'munitions', 'steel', 'aluminum', 'food', 'credits'];
const DELIVERY_MODES = [
  { name: 'Immediate', value: 'immediate' },
  { name: 'Daily digest', value: 'daily' },
  { name: 'Weekly digest', value: 'weekly' },
];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const ACTIVITY_PAGE_SIZE = 5;

const safeMessage = (message) => ({
  ...message,
  allowedMentions: { parse: [] },
});

const addCommonOptions = (subcommand) => subcommand
  .addStringOption((option) => option.setName('name').setDescription('Optional label').setMaxLength(100))
  .addIntegerOption((option) => option.setName('cooldown').setDescription('Minutes between matching alerts').setMinValue(5).setMaxValue(10080))
  .addStringOption((option) => option.setName('delivery').setDescription('When Discord should deliver').addChoices(...DELIVERY_MODES))
  .addBooleanOption((option) => option.setName('discord').setDescription('Opt this alert into private Discord delivery'))
  .addIntegerOption((option) => option.setName('expires_days').setDescription('Automatically expire after this many days').setMinValue(1).setMaxValue(365))
  .addStringOption((option) => option.setName('timezone').setDescription('Optional IANA time zone override, such as America/Chicago').setMaxLength(64));

const addEditOptions = (subcommand) => subcommand
  .addStringOption((option) => option.setName('name').setDescription('Updated label').setMaxLength(100))
  .addIntegerOption((option) => option.setName('cooldown').setDescription('Updated minutes between matching alerts').setMinValue(5).setMaxValue(10080))
  .addStringOption((option) => option.setName('delivery').setDescription('Updated Discord delivery schedule').addChoices(...DELIVERY_MODES))
  .addBooleanOption((option) => option.setName('discord').setDescription('Opt this alert into private Discord delivery'))
  .addIntegerOption((option) => option.setName('expires_days').setDescription('Days until expiry; use 0 to remove expiry').setMinValue(0).setMaxValue(365))
  .addStringOption((option) => option.setName('timezone').setDescription('Updated IANA time zone override').setMaxLength(64))
  .addStringOption((option) => {
    const resource = option.setName('resource').setDescription('Updated market resource');
    RESOURCES.forEach((value) => resource.addChoices({ name: value, value }));
    return resource;
  })
  .addStringOption((option) => option.setName('direction').setDescription('Updated market threshold direction').addChoices(
    { name: 'At or above', value: 'above' },
    { name: 'At or below', value: 'below' },
  ))
  .addNumberOption((option) => option.setName('price').setDescription('Updated market price threshold').setMinValue(0.01).setMaxValue(1000000000))
  .addNumberOption((option) => option.setName('rearm').setDescription('Updated market rearm percentage').setMinValue(0.01).setMaxValue(25));

export const data = new SlashCommandBuilder()
  .setName('alerts')
  .setDescription('Manage private Nexus alerts and watchlists.')
  .addSubcommand((subcommand) => subcommand.setName('list').setDescription('List alert state, delivery policy, and health.'))
  .addSubcommand((subcommand) => subcommand
    .setName('activity')
    .setDescription('View alert activity or inspect and update one receipt.')
    .addIntegerOption((option) => option.setName('delivery').setDescription('Activity or delivery ID').setMinValue(1))
    .addStringOption((option) => option.setName('action').setDescription('Action for the supplied delivery ID').addChoices(
      { name: 'View receipt', value: 'details' },
      { name: 'Mark read', value: 'read' },
      { name: 'Mark unread', value: 'unread' },
    )))
  .addSubcommand((subcommand) => subcommand
    .setName('settings')
    .setDescription('View or update Discord, time zone, quiet hours, and digest defaults.')
    .addBooleanOption((option) => option.setName('discord').setDescription('Enable private Discord delivery globally'))
    .addStringOption((option) => option.setName('timezone').setDescription('IANA time zone, such as America/Chicago').setMaxLength(64))
    .addBooleanOption((option) => option.setName('quiet_hours').setDescription('Enable or disable quiet hours'))
    .addStringOption((option) => option.setName('quiet_start').setDescription('Quiet-hours start in 24-hour HH:MM format').setMaxLength(5))
    .addStringOption((option) => option.setName('quiet_end').setDescription('Quiet-hours end in 24-hour HH:MM format').setMaxLength(5))
    .addStringOption((option) => option.setName('digest_time').setDescription('Default digest time in 24-hour HH:MM format').setMaxLength(5))
    .addIntegerOption((option) => option.setName('digest_weekday').setDescription('Weekly digest day: Monday is 1').setMinValue(1).setMaxValue(7)))
  .addSubcommand((subcommand) => addCommonOptions(subcommand
    .setName('nation')
    .setDescription('Choose one or more events for a nation watchlist.')
    .addIntegerOption((option) => option.setName('nation').setDescription('Politics & War nation ID').setRequired(true).setMinValue(1))))
  .addSubcommand((subcommand) => addCommonOptions(subcommand
    .setName('alliance')
    .setDescription('Choose one or more events for an alliance watchlist.')
    .addIntegerOption((option) => option.setName('alliance').setDescription('Politics & War alliance ID').setRequired(true).setMinValue(1))))
  .addSubcommand((subcommand) => addCommonOptions(subcommand
    .setName('market')
    .setDescription('Alert when a market price crosses a threshold.')
    .addStringOption((option) => {
      const resource = option.setName('resource').setDescription('Resource').setRequired(true);
      RESOURCES.forEach((value) => resource.addChoices({ name: value, value }));
      return resource;
    })
    .addStringOption((option) => option.setName('direction').setDescription('Threshold direction').setRequired(true).addChoices(
      { name: 'At or above', value: 'above' },
      { name: 'At or below', value: 'below' },
    ))
    .addNumberOption((option) => option.setName('price').setDescription('Price threshold').setRequired(true).setMinValue(0.01).setMaxValue(1000000000))
    .addNumberOption((option) => option.setName('rearm').setDescription('Percent price must cross back before rearming').setMinValue(0.01).setMaxValue(25))))
  .addSubcommand((subcommand) => addEditOptions(subcommand
    .setName('edit')
    .setDescription('Edit delivery policy or a market threshold after preview.')
    .addIntegerOption((option) => option.setName('id').setDescription('Alert ID from /alerts list').setRequired(true).setMinValue(1))))
  .addSubcommand((subcommand) => subcommand
    .setName('manage')
    .setDescription('Pause, resume, test, or delete an alert after confirmation.')
    .addIntegerOption((option) => option.setName('id').setDescription('Alert ID from /alerts list').setRequired(true).setMinValue(1))
    .addStringOption((option) => option.setName('action').setDescription('Action').setRequired(true).addChoices(
      { name: 'Pause', value: 'pause' },
      { name: 'Resume', value: 'resume' },
      { name: 'Send marked test', value: 'test' },
      { name: 'Delete', value: 'delete' },
    )))
  .setDMPermission(false);

export const help = Object.freeze({
  audience: 'Members',
  topic: Object.freeze(['member']),
  examples: Object.freeze([
    '/alerts list',
    '/alerts nation nation:<nation> discord:True',
    '/alerts edit id:<id> delivery:Daily digest',
    '/alerts settings timezone:America/Chicago quiet_hours:True quiet_start:22:00 quiet_end:07:00',
    '/alerts activity',
  ]),
  related: Object.freeze(['audit']),
});

const optional = (target, key, value) => {
  if (value !== null && value !== undefined && value !== '') target[key] = value;
  return target;
};

const expiration = (days, now) => {
  if (days === null) return undefined;
  return new Date(now + (days * 24 * 60 * 60 * 1000)).toISOString();
};

const createPayload = (interaction, subcommand, now = Date.now()) => {
  const common = {
    cooldown_minutes: interaction.options.getInteger('cooldown') ?? 60,
    delivery_mode: interaction.options.getString('delivery') ?? 'immediate',
    discord_enabled: interaction.options.getBoolean('discord') ?? false,
  };
  optional(common, 'name', interaction.options.getString('name')?.trim());
  optional(common, 'timezone', interaction.options.getString('timezone')?.trim());
  optional(common, 'expires_at', expiration(interaction.options.getInteger('expires_days'), now));

  if (subcommand === 'nation') {
    return {
      ...common,
      type: 'nation',
      target_id: interaction.options.getInteger('nation'),
    };
  }
  if (subcommand === 'alliance') {
    return {
      ...common,
      type: 'alliance',
      target_id: interaction.options.getInteger('alliance'),
    };
  }
  return {
    ...common,
    type: 'market',
    resource: interaction.options.getString('resource'),
    direction: interaction.options.getString('direction'),
    threshold: interaction.options.getNumber('price'),
    rearm_percent: interaction.options.getNumber('rearm') ?? 1,
  };
};

const subscriptionPayload = (alert) => {
  const payload = {
    type: alert.type,
    name: alert.name,
    cooldown_minutes: alert.cooldown_minutes ?? 60,
    delivery_mode: alert.delivery?.mode ?? 'immediate',
    discord_enabled: alert.delivery?.discord_enabled ?? false,
    rearm_percent: alert.rearm_percent ?? 1,
    expires_at: alert.expires_at ?? null,
  };
  optional(payload, 'timezone', alert.delivery?.timezone);
  if (alert.type === 'market') {
    const { resource, direction, threshold } = alert.filter ?? {};
    if (!resource || !['above', 'below'].includes(direction) || !Number.isFinite(Number(threshold))) {
      throw new TypeError('Nexus did not return a complete typed market filter. Edit this alert in Nexus web.');
    }
    return {
      ...payload,
      resource,
      direction,
      threshold: Number(threshold),
    };
  }
  const events = Array.isArray(alert.events)
    ? alert.events.map((event) => event?.key).filter(Boolean)
    : [];
  const targetId = alert.filter?.target_id ?? alert.target_id;
  if (!['nation', 'alliance'].includes(alert.type) || !targetId || events.length === 0) {
    throw new TypeError('Nexus did not return a complete typed watchlist filter. Edit this alert in Nexus web.');
  }
  return {
    ...payload,
    target_id: Number(targetId),
    events,
  };
};

const editPayload = (alert, interaction, now) => {
  const payload = subscriptionPayload(alert);
  const name = interaction.options.getString('name')?.trim();
  const cooldown = interaction.options.getInteger('cooldown');
  const delivery = interaction.options.getString('delivery');
  const discord = interaction.options.getBoolean('discord');
  const expiresDays = interaction.options.getInteger('expires_days');
  const timezone = interaction.options.getString('timezone')?.trim();
  const resource = interaction.options.getString('resource');
  const direction = interaction.options.getString('direction');
  const threshold = interaction.options.getNumber('price');
  const rearm = interaction.options.getNumber('rearm');

  if (name) payload.name = name;
  if (cooldown !== null) payload.cooldown_minutes = cooldown;
  if (delivery !== null) payload.delivery_mode = delivery;
  if (discord !== null) payload.discord_enabled = discord;
  if (expiresDays !== null) payload.expires_at = expiresDays === 0 ? null : expiration(expiresDays, now);
  if (timezone) payload.timezone = timezone;
  if ([resource, direction, threshold, rearm].some((value) => value !== null) && alert.type !== 'market') {
    throw new TypeError('Market filter options can be used only with a market alert.');
  }
  if (resource !== null) payload.resource = resource;
  if (direction !== null) payload.direction = direction;
  if (threshold !== null) payload.threshold = threshold;
  if (rearm !== null) payload.rearm_percent = rearm;
  return payload;
};

const findAlert = async (context, actor, alertId) => {
  const response = await context.apiService.getMyAlerts(actor);
  const collection = normalizeCollection(response?.alerts ?? response);
  const alert = collection.items.find((item) => Number(item?.id) === Number(alertId));
  if (!alert) throw new TypeError(`Alert #${alertId} was not found in your Nexus account.`);
  return alert;
};

const subscriptionFingerprint = (alert) => JSON.stringify(subscriptionPayload(alert));

const eventChoices = (type) => (type === 'nation' ? NATION_EVENTS : ALLIANCE_EVENTS);

const chooseEventsMessage = (interaction, context, payload) => {
  const choices = eventChoices(payload.type);
  const selectId = context.sessions.create({
    commandName: 'alerts',
    userId: interaction.user.id,
    event: 'select-events',
    state: { payload },
    oneShot: true,
  });
  return safeMessage(statusMessage({
    title: `Choose ${titleCase(payload.type)} Events`,
    tone: 'info',
    description: `Select every change Nexus should watch for ${payload.type} **#${formatNumber(payload.target_id, { maximumFractionDigits: 0 })}**.`,
    footer: 'You will preview delivery policy and test the alert before saving.',
    components: [new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(selectId)
        .setPlaceholder('Choose one or more events')
        .setMinValues(1)
        .setMaxValues(choices.length)
        .addOptions(choices.map(([label, value]) => ({ label, value }))),
    )],
  }));
};

const deliveryLabel = (delivery = {}) => {
  const mode = titleCase(delivery.mode ?? 'immediate');
  if (!delivery.discord_enabled) return `${mode} · Web only`;
  if (delivery.global_discord_enabled === false) return `${mode} · Discord globally disabled`;
  if (delivery.health && delivery.health !== 'healthy') return `${mode} · ${titleCase(delivery.health)}`;
  return `${mode} · Discord enabled`;
};

const decorateAlert = (alert) => ({
  ...alert,
  name: alert.delivery?.health === 'unhealthy' ? `Delivery issue · ${alert.name}` : alert.name,
  type_label: [alert.type_label, deliveryLabel(alert.delivery)].filter(Boolean).join(' · '),
  last_triggered_at: alert.last_matched_at ?? alert.last_triggered_at,
});

const listAlerts = async (interaction, context, actor) => {
  const [alertsResponse, settings] = await Promise.all([
    context.apiService.getMyAlerts(actor),
    context.apiService.getAlertSettings(actor),
  ]);
  const collection = normalizeCollection(alertsResponse?.alerts ?? alertsResponse);
  collection.items = collection.items.map(decorateAlert);
  const globalDelivery = settings?.discord_enabled ? 'Discord delivery enabled' : 'Discord delivery disabled';
  await interaction.editReply(safeMessage(collectionMessage({
    title: 'Your Nexus Alerts',
    collection,
    empty: 'You have no custom alerts. Use `/alerts nation`, `/alerts alliance`, or `/alerts market` to create one.',
    commandName: 'alerts',
    userId: interaction.user.id,
    sessions: context.sessions,
    variant: 'alert',
    description: `${globalDelivery} · ${settings?.timezone ?? 'UTC'} · Web activity is always recorded.`,
    baseUrl: context.apiService.baseUrl,
    pageSize: 4,
  })));
};

const draftControls = (interaction, context, payload, {
  alertId = null, canSave = true, includeTest = true, operation = 'create', sourceFingerprint = null,
} = {}) => {
  const buttons = [];
  if (includeTest) {
    buttons.push(new ButtonBuilder()
      .setCustomId(context.sessions.create({
        commandName: 'alerts', userId: interaction.user.id, event: 'test-draft',
        state: {
          payload, operation, alertId, sourceFingerprint,
        },
        oneShot: true,
      }))
      .setLabel('Send marked test')
      .setStyle(ButtonStyle.Primary));
  }
  buttons.push(new ButtonBuilder()
    .setCustomId(context.sessions.create({
      commandName: 'alerts', userId: interaction.user.id,
      event: operation === 'update' ? 'confirm-update' : 'confirm-create',
      state: { payload, alertId, sourceFingerprint }, oneShot: true,
    }))
    .setLabel(operation === 'update' ? 'Save changes' : 'Create alert')
    .setStyle(ButtonStyle.Success)
    .setDisabled(!canSave));
  buttons.push(new ButtonBuilder()
    .setCustomId(context.sessions.create({
      commandName: 'alerts', userId: interaction.user.id, event: 'cancel', state: {}, oneShot: true,
    }))
    .setLabel('Cancel')
    .setStyle(ButtonStyle.Secondary));
  return [new ActionRowBuilder().addComponents(buttons)];
};

const draftPreviewMessage = (interaction, context, payload, preview, {
  alertId = null, operation = 'create', sourceFingerprint = null,
} = {}) => {
  const events = Array.isArray(preview?.events)
    ? preview.events.map((event) => event.label).join(', ')
    : null;
  const fields = [
    { name: 'Condition', value: escapeMarkdown(truncate(preview?.condition ?? events ?? 'Validated by Nexus', 1_000)) },
    { name: 'Delivery', value: deliveryLabel(preview?.delivery), inline: true },
    { name: 'Cooldown', value: `${formatNumber(preview?.cooldown_minutes ?? 60, { maximumFractionDigits: 0 })} minutes`, inline: true },
    preview?.delivery?.timezone ? { name: 'Time zone', value: escapeMarkdown(preview.delivery.timezone), inline: true } : null,
    preview?.expires_at ? { name: 'Expires', value: formatDiscordTime(preview.expires_at), inline: true } : null,
    preview?.type === 'market' ? { name: 'Rearm buffer', value: `${formatNumber(preview?.rearm_percent ?? 1)}%`, inline: true } : null,
  ];
  return safeMessage(statusMessage({
    title: operation === 'update' ? `Review Changes to Alert #${alertId}` : 'Review Alert Before Saving',
    tone: preview?.can_save === false ? 'warning' : 'info',
    description: `**${escapeMarkdown(truncate(preview?.name ?? 'New alert', 100))}** · ${escapeMarkdown(preview?.type_label ?? titleCase(payload.type))}`,
    fields,
    footer: preview?.can_save === false && operation !== 'update'
      ? 'Your active-alert limit is reached. Pause or delete an alert before saving.'
      : operation === 'update'
        ? 'Testing does not save these edits. Trigger changes reset the baseline only after you confirm the update.'
        : 'Testing does not save the subscription or change baselines. Nexus establishes a baseline after creation.',
    components: draftControls(interaction, context, payload, {
      alertId, canSave: preview?.can_save !== false || operation === 'update', operation, sourceFingerprint,
    }),
  }));
};

const previewDraft = async (interaction, context, actor, payload, options = {}) => {
  const preview = await context.apiService.previewAlert(actor, payload);
  await interaction.editReply(draftPreviewMessage(interaction, context, payload, preview, options));
};

const testOutcome = (result) => {
  const deliveries = Array.isArray(result?.deliveries) ? result.deliveries : [];
  const statuses = new Set(deliveries.map((delivery) => delivery.status));
  if (statuses.has('failed') || statuses.has('undeliverable') || statuses.has('quarantined')) {
    return { title: 'Alert Test Needs Attention', tone: 'warning' };
  }
  if (statuses.has('queued') || result?.queued) return { title: 'Alert Test Queued', tone: 'info' };
  if (statuses.has('delivered')) return { title: 'Alert Test Delivered', tone: 'success' };
  return { title: 'Alert Test Recorded', tone: 'neutral' };
};

const testResultMessage = (interaction, context, result, draft = null) => {
  const outcome = testOutcome(result);
  const deliveries = Array.isArray(result?.deliveries) ? result.deliveries : [];
  const fields = deliveries.map((delivery) => ({
    name: `${titleCase(delivery.destination_kind ?? 'delivery')} · #${formatNumber(delivery.id, { maximumFractionDigits: 0 })}`,
    value: [
      `**Status:** ${titleCase(delivery.status ?? 'unknown')}`,
      delivery.delivery_mode ? `**Mode:** ${titleCase(delivery.delivery_mode)}` : null,
      delivery.reason_code ? `**Reason:** ${titleCase(delivery.reason_code)}` : null,
    ].filter(Boolean).join('\n'),
  }));
  return safeMessage(statusMessage({
    ...outcome,
    description: `Nexus recorded marked test occurrence **#${formatNumber(result?.occurrence_id, { maximumFractionDigits: 0 })}**. The states below are authoritative; a queued test may still be awaiting its final Discord receipt.`,
    fields,
    footer: 'Web activity remains available even when private Discord delivery is disabled or unavailable.',
    components: draft ? draftControls(interaction, context, draft.payload, {
      alertId: draft.alertId,
      includeTest: false,
      operation: draft.operation,
      sourceFingerprint: draft.sourceFingerprint,
    }) : [],
  }));
};

const createdMessage = (created) => safeMessage(statusMessage({
  title: 'Alert Created',
  tone: 'success',
  description: `Created alert **#${formatNumber(created?.id, { maximumFractionDigits: 0 })} · ${escapeMarkdown(truncate(created?.name ?? 'New alert', 100))}**.`,
  footer: 'Nexus will establish a baseline before sending matched notifications. Web activity is always recorded.',
}));

const updatedMessage = (updated) => safeMessage(statusMessage({
  title: 'Alert Updated',
  tone: 'success',
  description: `Updated alert **#${formatNumber(updated?.id, { maximumFractionDigits: 0 })} · ${escapeMarkdown(truncate(updated?.name ?? 'Alert', 100))}**.`,
  footer: 'Nexus preserves the existing baseline for delivery-only edits and re-establishes it when trigger criteria change.',
}));

const timeValue = (value, label) => {
  if (value === null || value === undefined) return null;
  const normalized = `${value}`.trim();
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(normalized)) {
    throw new TypeError(`${label} must use 24-hour HH:MM format.`);
  }
  return normalized;
};

const settingInputs = (interaction) => ({
  discord: interaction.options.getBoolean('discord'),
  timezone: interaction.options.getString('timezone'),
  quietHours: interaction.options.getBoolean('quiet_hours'),
  quietStart: interaction.options.getString('quiet_start'),
  quietEnd: interaction.options.getString('quiet_end'),
  digestTime: interaction.options.getString('digest_time'),
  digestWeekday: interaction.options.getInteger('digest_weekday'),
});

const settingsPayload = (settings, input) => {
  const currentQuiet = settings?.quiet_hours ?? {};
  let quietStart = currentQuiet.start ?? null;
  let quietEnd = currentQuiet.end ?? null;
  if (input.quietHours === false) {
    quietStart = null;
    quietEnd = null;
  } else if (input.quietHours === true || input.quietStart !== null || input.quietEnd !== null) {
    quietStart = timeValue(input.quietStart ?? quietStart, 'Quiet-hours start');
    quietEnd = timeValue(input.quietEnd ?? quietEnd, 'Quiet-hours end');
    if (!quietStart || !quietEnd) throw new TypeError('Provide both quiet-hours start and end times.');
    if (quietStart === quietEnd) throw new TypeError('Quiet-hours start and end must differ.');
  }
  return {
    timezone: input.timezone?.trim() || settings?.timezone || 'UTC',
    quiet_hours_start: quietStart,
    quiet_hours_end: quietEnd,
    default_digest_time: timeValue(input.digestTime ?? settings?.default_digest?.time ?? '09:00', 'Digest time'),
    default_digest_weekday: input.digestWeekday ?? settings?.default_digest?.weekday ?? 1,
    discord_enabled: input.discord ?? settings?.discord_enabled ?? false,
  };
};

const settingsProjection = (payload) => ({
  timezone: payload.timezone,
  quiet_hours: {
    enabled: Boolean(payload.quiet_hours_start && payload.quiet_hours_end),
    start: payload.quiet_hours_start,
    end: payload.quiet_hours_end,
  },
  default_digest: {
    time: payload.default_digest_time,
    weekday: payload.default_digest_weekday,
  },
  discord_enabled: payload.discord_enabled,
});

const settingsFingerprint = (current) => JSON.stringify(settingsPayload(current, {
  discord: null,
  timezone: null,
  quietHours: null,
  quietStart: null,
  quietEnd: null,
  digestTime: null,
  digestWeekday: null,
}));

const settingsMessage = (settings, { title = 'Alert Delivery Settings', tone = 'info', components = [] } = {}) => safeMessage(statusMessage({
  title,
  tone,
  description: 'These defaults apply to your private member alerts. Web activity is always enabled.',
  fields: [
    { name: 'Discord delivery', value: settings?.discord_enabled ? 'Enabled' : 'Disabled', inline: true },
    { name: 'Time zone', value: escapeMarkdown(settings?.timezone ?? 'UTC'), inline: true },
    {
      name: 'Quiet hours',
      value: settings?.quiet_hours?.enabled
        ? `${settings.quiet_hours.start}–${settings.quiet_hours.end}`
        : 'Disabled',
      inline: true,
    },
    { name: 'Daily digest', value: settings?.default_digest?.time ?? '09:00', inline: true },
    {
      name: 'Weekly digest',
      value: `${WEEKDAYS[(settings?.default_digest?.weekday ?? 1) - 1] ?? 'Monday'} at ${settings?.default_digest?.time ?? '09:00'}`,
      inline: true,
    },
  ],
  footer: settings?.uses_legacy_defaults
    ? 'Nexus is showing migrated defaults. Confirm an update to persist your preferred time zone.'
    : 'Use /alerts settings with one or more options to propose a change.',
  components,
}));

const settingsConfirmation = (interaction, context, payload, current) => {
  const confirmId = context.sessions.create({
    commandName: 'alerts', userId: interaction.user.id, event: 'confirm-settings',
    state: { payload, sourceFingerprint: settingsFingerprint(current) }, oneShot: true,
  });
  const cancelId = context.sessions.create({
    commandName: 'alerts', userId: interaction.user.id, event: 'cancel', state: {}, oneShot: true,
  });
  return settingsMessage(settingsProjection(payload), {
    title: 'Confirm Alert Settings',
    tone: 'warning',
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(confirmId).setLabel('Save settings').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(cancelId).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    )],
  });
};

const activityStatus = (item) => {
  const deliveries = Array.isArray(item?.deliveries) ? item.deliveries : [];
  if (!deliveries.length) return 'Recorded';
  return deliveries
    .map((delivery) => `${titleCase(delivery.destination_kind)}${delivery.id ? ` #${delivery.id}` : ''}: ${titleCase(delivery.status)}`)
    .join(' · ');
};

const activityField = (item, baseUrl) => {
  const link = resolveDeepLink(baseUrl, item.deep_link_path);
  const context = item?.payload?.summary ?? item?.payload?.message ?? item?.payload?.condition;
  return {
    name: `${item.read_at ? 'Read' : 'Unread'} · ${truncate(item.event_label ?? titleCase(item.event_key), 180)}`,
    value: [
      `**Activity:** #${formatNumber(item.activity_id, { maximumFractionDigits: 0 })}`,
      `**Severity:** ${titleCase(item.severity ?? 'normal')}`,
      `**Outcome:** ${activityStatus(item)}`,
      item.occurred_at ? `**Occurred:** ${formatDiscordTime(item.occurred_at)}` : null,
      item.is_test ? '**Marked test:** Yes' : null,
      context ? `**Context:** ${escapeMarkdown(truncate(context, 500))}` : null,
      link ? `[Open authoritative Nexus record](${link})` : null,
    ].filter(Boolean).join('\n'),
  };
};

const activityPageMessage = (interaction, context, response, before = null, stack = []) => {
  const items = Array.isArray(response?.items) ? response.items : [];
  const buttons = [];
  if (stack.length > 0) {
    const previousStack = stack.slice(0, -1);
    buttons.push(new ButtonBuilder()
      .setCustomId(context.sessions.create({
        commandName: 'alerts', userId: interaction.user.id, event: 'activity-page',
        state: { before: stack.at(-1), stack: previousStack }, oneShot: true,
      }))
      .setLabel('← Newer')
      .setStyle(ButtonStyle.Secondary));
  }
  if (response?.next_cursor) {
    buttons.push(new ButtonBuilder()
      .setCustomId(context.sessions.create({
        commandName: 'alerts', userId: interaction.user.id, event: 'activity-page',
        state: { before: response.next_cursor, stack: [...stack, before] }, oneShot: true,
      }))
      .setLabel('Older →')
      .setStyle(ButtonStyle.Secondary));
  }
  return safeMessage(statusMessage({
    title: 'Alert Activity',
    tone: 'info',
    description: items.length
      ? 'Canonical matched, suppressed, queued, delivered, and failed alert activity from Nexus.'
      : 'No alert activity is available in the retained 30-day window.',
    fields: items.map((item) => activityField(item, context.apiService.baseUrl)),
    footer: items.length ? 'Use /alerts activity delivery:<id> to inspect a receipt or change its read state.' : null,
    components: buttons.length ? [new ActionRowBuilder().addComponents(buttons)] : [],
  }));
};

const receiptMessage = (delivery) => safeMessage(statusMessage({
  title: `Alert Delivery #${formatNumber(delivery?.id, { maximumFractionDigits: 0 })}`,
  tone: ['failed', 'undeliverable', 'quarantined'].includes(delivery?.status) ? 'warning' : 'info',
  description: `Receipt for **${escapeMarkdown(titleCase(delivery?.event_key ?? 'alert'))}**.`,
  fields: [
    { name: 'Destination', value: titleCase(delivery?.destination_kind ?? 'unknown'), inline: true },
    { name: 'Status', value: titleCase(delivery?.status ?? 'unknown'), inline: true },
    { name: 'Mode', value: titleCase(delivery?.delivery_mode ?? 'immediate'), inline: true },
    delivery?.reason_code ? { name: 'Reason', value: titleCase(delivery.reason_code), inline: true } : null,
    delivery?.scheduled_at ? { name: 'Scheduled', value: formatDiscordTime(delivery.scheduled_at), inline: true } : null,
    delivery?.queued_at ? { name: 'Queued', value: formatDiscordTime(delivery.queued_at), inline: true } : null,
    delivery?.delivered_at ? { name: 'Delivered', value: formatDiscordTime(delivery.delivered_at), inline: true } : null,
    delivery?.failed_at ? { name: 'Failed', value: formatDiscordTime(delivery.failed_at), inline: true } : null,
    delivery?.batch ? {
      name: 'Provider receipt',
      value: [
        `**Batch:** #${formatNumber(delivery.batch.id, { maximumFractionDigits: 0 })}`,
        `**State:** ${titleCase(delivery.batch.status)}`,
        `**Attempts:** ${formatNumber(delivery.batch.attempt_count ?? 0, { maximumFractionDigits: 0 })}`,
        delivery.batch.failure_code ? `**Failure:** ${titleCase(delivery.batch.failure_code)}` : null,
        delivery.batch.last_attempt?.error_code ? `**Last error:** ${titleCase(delivery.batch.last_attempt.error_code)}` : null,
      ].filter(Boolean).join('\n'),
    } : null,
  ],
  footer: 'Nexus exposes normalized status and error codes without provider payloads or sensitive diagnostics.',
}));

const activityReadConfirmation = (interaction, context, deliveryId, read) => {
  const confirmId = context.sessions.create({
    commandName: 'alerts', userId: interaction.user.id, event: 'confirm-activity-read',
    state: { deliveryId, read }, oneShot: true,
  });
  const cancelId = context.sessions.create({
    commandName: 'alerts', userId: interaction.user.id, event: 'cancel', state: {}, oneShot: true,
  });
  return safeMessage(statusMessage({
    title: `Confirm Mark ${read ? 'Read' : 'Unread'}`,
    tone: 'warning',
    description: `Change activity **#${formatNumber(deliveryId, { maximumFractionDigits: 0 })}** to ${read ? 'read' : 'unread'}?`,
    footer: 'This changes only your private Nexus activity state; it does not acknowledge or resolve an operational incident.',
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(confirmId).setLabel(`Mark ${read ? 'read' : 'unread'}`).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(cancelId).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    )],
  }));
};

const manageCopy = {
  pause: {
    title: 'Confirm Alert Pause', description: 'Matched activity will remain visible in Nexus, but this subscription will stop matching new changes.', label: 'Pause alert', style: ButtonStyle.Danger,
  },
  resume: {
    title: 'Confirm Alert Resume', description: 'Nexus will revalidate eligibility, expiration, and duplicate constraints before resuming.', label: 'Resume alert', style: ButtonStyle.Success,
  },
  test: {
    title: 'Confirm Marked Alert Test', description: 'Nexus will record a marked test occurrence and report each web and Discord delivery state.', label: 'Send marked test', style: ButtonStyle.Primary,
  },
  delete: {
    title: 'Confirm Alert Deletion', description: 'The subscription will be deleted. Retained activity and delivery receipts remain subject to Nexus retention policy.', label: 'Delete alert', style: ButtonStyle.Danger,
  },
};

const manageConfirmation = (interaction, context, id, action) => {
  const copy = manageCopy[action];
  const confirmId = context.sessions.create({
    commandName: 'alerts', userId: interaction.user.id, event: 'confirm-manage', state: { id, action }, oneShot: true,
  });
  const cancelId = context.sessions.create({
    commandName: 'alerts', userId: interaction.user.id, event: 'cancel', state: {}, oneShot: true,
  });
  return safeMessage(statusMessage({
    title: copy.title,
    tone: 'warning',
    description: `${copy.description}\n\nAlert: **#${formatNumber(id, { maximumFractionDigits: 0 })}**`,
    footer: 'Nexus revalidates ownership and current state when you confirm.',
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(confirmId).setLabel(copy.label).setStyle(copy.style),
      new ButtonBuilder().setCustomId(cancelId).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    )],
  }));
};

const manageResultMessage = (id, action) => safeMessage(statusMessage({
  title: { pause: 'Alert Paused', resume: 'Alert Resumed', delete: 'Alert Deleted' }[action],
  tone: ['pause', 'delete'].includes(action) ? 'warning' : 'success',
  description: `Alert **#${formatNumber(id, { maximumFractionDigits: 0 })}** was ${{ pause: 'paused', resume: 'resumed', delete: 'deleted' }[action]}.`,
  footer: 'Your alert state is synchronized with Nexus.',
}));

const hasSettingsChanges = (input) => Object.values(input).some((value) => value !== null);

export const execute = async (interaction, context) => {
  await deferEphemeral(interaction);
  const actor = actorFromInteraction(interaction, 'alerts');
  const subcommand = interaction.options.getSubcommand();

  try {
    if (subcommand === 'list') {
      await listAlerts(interaction, context, actor);
      return;
    }

    if (subcommand === 'settings') {
      const settings = await context.apiService.getAlertSettings(actor);
      const input = settingInputs(interaction);
      await interaction.editReply(hasSettingsChanges(input)
        ? settingsConfirmation(interaction, context, settingsPayload(settings, input), settings)
        : settingsMessage(settings));
      return;
    }

    if (subcommand === 'activity') {
      const deliveryId = interaction.options.getInteger('delivery');
      const action = interaction.options.getString('action') ?? (deliveryId ? 'details' : null);
      if (!deliveryId && action) throw new TypeError('Provide an activity or delivery ID for that action.');
      if (!deliveryId) {
        const response = await context.apiService.getAlertActivity(actor, { limit: ACTIVITY_PAGE_SIZE });
        await interaction.editReply(activityPageMessage(interaction, context, response));
      } else if (action === 'details') {
        await interaction.editReply(receiptMessage(await context.apiService.getAlertDelivery(actor, deliveryId)));
      } else {
        await interaction.editReply(activityReadConfirmation(interaction, context, deliveryId, action === 'read'));
      }
      return;
    }

    if (subcommand === 'edit') {
      const alertId = interaction.options.getInteger('id');
      const alert = await findAlert(context, actor, alertId);
      const payload = editPayload(alert, interaction, context.now?.() ?? Date.now());
      await previewDraft(interaction, context, actor, payload, {
        operation: 'update', alertId, sourceFingerprint: subscriptionFingerprint(alert),
      });
      return;
    }

    if (subcommand === 'manage') {
      await interaction.editReply(manageConfirmation(
        interaction,
        context,
        interaction.options.getInteger('id'),
        interaction.options.getString('action'),
      ));
      return;
    }

    const payload = createPayload(interaction, subcommand, context.now?.() ?? Date.now());
    if (subcommand === 'nation' || subcommand === 'alliance') {
      await interaction.editReply(chooseEventsMessage(interaction, context, payload));
      return;
    }
    await previewDraft(interaction, context, actor, payload);
  } catch (error) {
    await replyError(interaction, error, 'Alert Request Failed');
  }
};

export const select = async (interaction, context) => {
  await interaction.deferUpdate();
  try {
    if (context.session?.event !== 'select-events') throw new TypeError('This alert event selector has expired.');
    const payload = context.session.state?.payload;
    const allowed = new Set(eventChoices(payload?.type).map(([, value]) => value));
    const events = [...new Set(interaction.values ?? [])].filter((event) => allowed.has(event));
    if (!payload || !['nation', 'alliance'].includes(payload.type) || events.length === 0) {
      throw new TypeError('Choose at least one supported alert event.');
    }
    const draft = { ...payload, events };
    const preview = await context.apiService.previewAlert(actorFromInteraction(interaction, 'alerts'), draft);
    await interaction.editReply(draftPreviewMessage(interaction, context, draft, preview));
  } catch (error) {
    await replyError(interaction, error, 'Alert Preview Failed');
  }
};

export const button = async (interaction, context) => {
  const event = context.session?.event;
  if (event === 'cancel') {
    await interaction.update(safeMessage(statusMessage({
      title: 'Alert Action Cancelled',
      tone: 'neutral',
      description: 'No alert, delivery preference, or activity state was changed.',
    })));
    return;
  }

  await interaction.deferUpdate();
  const actor = actorFromInteraction(interaction, 'alerts');
  try {
    if (event === 'confirm-create') {
      const created = await context.apiService.createAlert(actor, context.session.state.payload);
      await interaction.editReply(createdMessage(created));
      return;
    }
    if (event === 'confirm-update') {
      const { alertId, payload, sourceFingerprint } = context.session.state;
      const current = await findAlert(context, actor, alertId);
      if (subscriptionFingerprint(current) !== sourceFingerprint) {
        throw new TypeError('This alert changed after the preview. Run /alerts edit again to review the current state.');
      }
      const updated = await context.apiService.updateAlert(actor, alertId, payload);
      await interaction.editReply(updatedMessage(updated));
      return;
    }
    if (event === 'test-draft') {
      const {
        alertId, operation, payload, sourceFingerprint,
      } = context.session.state;
      const result = await context.apiService.testAlertDraft(actor, payload);
      await interaction.editReply(testResultMessage(interaction, context, result, {
        alertId, operation, payload, sourceFingerprint,
      }));
      return;
    }
    if (event === 'confirm-settings') {
      const current = await context.apiService.getAlertSettings(actor);
      if (settingsFingerprint(current) !== context.session.state.sourceFingerprint) {
        throw new TypeError('Your alert settings changed after this preview. Run /alerts settings again to review them.');
      }
      const settings = await context.apiService.updateAlertSettings(actor, context.session.state.payload);
      await interaction.editReply(settingsMessage(settings, { title: 'Alert Settings Updated', tone: 'success' }));
      return;
    }
    if (event === 'activity-page') {
      const { before = null, stack = [] } = context.session.state;
      const response = await context.apiService.getAlertActivity(actor, {
        limit: ACTIVITY_PAGE_SIZE,
        before_delivery_id: before,
      });
      await interaction.editReply(activityPageMessage(interaction, context, response, before, stack));
      return;
    }
    if (event === 'confirm-activity-read') {
      const { deliveryId, read } = context.session.state;
      const result = await context.apiService.setAlertActivityRead(actor, deliveryId, read);
      await interaction.editReply(safeMessage(statusMessage({
        title: `Activity Marked ${read ? 'Read' : 'Unread'}`,
        tone: 'success',
        description: `Activity **#${formatNumber(result?.activity_id ?? deliveryId, { maximumFractionDigits: 0 })}** is now ${read ? 'read' : 'unread'}.`,
        footer: 'This does not acknowledge or resolve any operational workflow.',
      })));
      return;
    }
    if (event === 'confirm-manage') {
      const { id, action } = context.session.state;
      if (action === 'delete') {
        await context.apiService.deleteAlert(actor, id);
      } else if (action === 'test') {
        const result = await context.apiService.testAlert(actor, id);
        await interaction.editReply(testResultMessage(interaction, context, result));
        return;
      } else if (action === 'pause' || action === 'resume') {
        await context.apiService.updateAlertStatus(actor, id, action === 'resume');
      } else {
        throw new TypeError('This alert action is no longer supported.');
      }
      await interaction.editReply(manageResultMessage(id, action));
      return;
    }
    throw new TypeError('This alert control is invalid or expired.');
  } catch (error) {
    await replyError(interaction, error, 'Alert Action Failed');
  }
};
