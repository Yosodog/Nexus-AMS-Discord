import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import {
  buildEmbed,
  buildPlainMessage,
  pluralize,
  renderCollectionItem,
  variantConfig,
} from './discordUi.js';

export const COLLECTION_PAGE_EVENT = 'ui:collection-page';

export const actorFromInteraction = (interaction, command = null) => {
  const rootCommand = command ?? interaction.nexusCommandName ?? interaction.commandName ?? 'interaction';
  let subcommand = null;
  try {
    subcommand = interaction.options?.getSubcommand?.(false) ?? null;
  } catch {
    subcommand = null;
  }
  const action = subcommand && subcommand !== rootCommand ? `${rootCommand}.${subcommand}` : rootCommand;
  const connection = interaction.nexusConnectionContext;
  return {
    discordUserId: interaction.user.id,
    discordGuildId: interaction.guildId,
    discordInteractionId: interaction.id,
    discordCommand: rootCommand,
    discordAction: action,
    ...(connection ? {
      discordApplicationId: connection.applicationId,
      discordConnectionId: connection.connectionId,
      discordConnectionGeneration: connection.generation,
      discordRelayKeyId: connection.keyId,
    } : {}),
  };
};

export const errorMessage = (error) => {
  const messages = {
    DISCORD_ACCOUNT_NOT_LINKED: 'Link your Discord account in Nexus before using this command.',
    FORBIDDEN: 'You do not have permission to do that.',
    NOT_FOUND: 'That item is no longer available.',
    STALE_INTENT: 'This draft changed or expired. Start a new request.',
    INTENT_EXPIRED: 'This draft expired. Start a new request.',
    DUPLICATE_REQUEST: 'You already have an open request of this type.',
    VALIDATION_ERROR: 'Nexus could not validate that request.',
    FEATURE_DISABLED: 'This feature is currently disabled.',
  };
  const detail = typeof error?.message === 'string' && error.message.length <= 300 ? error.message : null;
  if (error?.code === 'VALIDATION_ERROR' && detail) return detail;
  return messages[error?.code]
    ?? detail
    ?? 'Nexus is unavailable right now. Please try again later.';
};

const errorGuidance = (error) => ({
  DISCORD_ACCOUNT_NOT_LINKED: 'Link your Discord account in Nexus, then run this command again.',
  DUPLICATE_REQUEST: 'Open your existing request in Nexus before starting another one.',
  FEATURE_DISABLED: 'Contact a Nexus administrator if you need access to this feature.',
  FORBIDDEN: 'If you believe you should have access, contact a Nexus administrator.',
  INTENT_EXPIRED: 'Run the command again to create a fresh draft.',
  NOT_FOUND: 'Refresh the list or run the command again to get current data.',
  STALE_INTENT: 'Run the command again to create a fresh draft.',
  VALIDATION_ERROR: 'Review the values above, then try again.',
}[error?.code] ?? 'Try the command again. If this keeps happening, contact a Nexus administrator.');

export const replyError = async (interaction, error, title = 'Request Failed') => {
  const payload = {
    embeds: [buildEmbed({
      title,
      tone: 'danger',
      description: errorMessage(error),
      footer: errorGuidance(error),
    })],
    components: [],
    ephemeral: true,
  };
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
  return interaction.reply(payload);
};

export const deferEphemeral = (interaction) => interaction.deferReply({ ephemeral: true });

export const normalizeCollection = (value) => {
  if (Array.isArray(value)) return {
    items: value, page: 1, pages: 1, total: value.length, remote: false,
  };
  const items = value?.items
    ?? value?.accounts
    ?? value?.transactions
    ?? value?.available
    ?? value?.requests
    ?? value?.loans
    ?? value?.applications
    ?? value?.wars
    ?? value?.assignments
    ?? value?.targets
    ?? value?.data
    ?? [];
  if (!Array.isArray(items)) throw new TypeError('Collection response is missing an items array.');
  const pagination = value?.pagination ?? value?.meta ?? {};
  const remote = Boolean(
    pagination
    && typeof pagination === 'object'
    && ['current_page', 'page', 'last_page', 'pages', 'total'].some((key) => pagination[key] !== undefined),
  );
  const page = Math.max(1, Number(pagination.current_page ?? pagination.page ?? 1) || 1);
  const pages = Math.max(1, Number(pagination.last_page ?? pagination.pages ?? 1) || 1);
  const total = Math.max(0, Number(pagination.total ?? items.length) || 0);
  const perPage = Math.max(1, Number(pagination.per_page ?? pagination.page_size ?? items.length) || Math.max(items.length, 1));
  return {
    items,
    page: Math.min(page, pages),
    pages,
    total,
    perPage,
    remote,
  };
};

export const summarizeItem = (item, index = 0) => {
  const rendered = renderCollectionItem('generic', item, index);
  return `**${rendered.name}**\n${rendered.value}`;
};

export const collectionMessage = ({
  title,
  collection,
  empty = 'Nothing to show.',
  commandName,
  userId,
  event = 'page',
  state = {},
  sessions,
  variant = 'generic',
  description,
  baseUrl,
  page: requestedPage,
  pageSize: requestedPageSize,
  noun: requestedNoun,
}) => {
  const config = variantConfig(variant);
  const noun = requestedNoun ?? config.noun;
  const pageSize = Math.max(1, Math.min(10, Number(requestedPageSize ?? config.pageSize) || config.pageSize));
  const isRemote = Boolean(collection.remote);
  const allItems = collection.items;
  const total = isRemote ? Math.max(collection.total, allItems.length) : allItems.length;
  const pages = isRemote
    ? Math.max(collection.pages, 1)
    : Math.max(Math.ceil(total / pageSize), 1);
  const page = Math.min(
    Math.max(1, Number(requestedPage ?? collection.page ?? 1) || 1),
    pages,
  );
  const start = isRemote ? Math.max(0, (page - 1) * collection.perPage) : (page - 1) * pageSize;
  const pageItems = isRemote ? allItems.slice(0, 10) : allItems.slice(start, start + pageSize);
  const end = Math.min(start + pageItems.length, total);
  const fields = pageItems.map((item, index) => renderCollectionItem(
    variant,
    item,
    start + index,
    { baseUrl },
  ));
  const footer = total === 0
    ? null
    : pages > 1
      ? `${start + 1}–${end} of ${total} ${pluralize(total, noun)} · Page ${page}/${pages}`
      : `${total} ${pluralize(total, noun)}`;
  const components = [];
  if (pages > 1 && sessions) {
    const localPresentation = {
      title,
      items: allItems,
      empty,
      commandName,
      variant,
      description,
      baseUrl,
      pageSize,
      noun,
    };
    const previousEvent = isRemote ? event : COLLECTION_PAGE_EVENT;
    const nextEvent = isRemote ? event : COLLECTION_PAGE_EVENT;
    const previousState = isRemote
      ? { ...state, page: page - 1 }
      : { presentation: localPresentation, page: page - 1 };
    const nextState = isRemote
      ? { ...state, page: page + 1 }
      : { presentation: localPresentation, page: page + 1 };
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(sessions.create({ commandName, userId, event: previousEvent, state: previousState }))
        .setLabel('← Previous')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 1),
      new ButtonBuilder()
        .setCustomId(sessions.create({ commandName, userId, event: nextEvent, state: nextState }))
        .setLabel('Next →')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= pages),
    ));
  }
  if (config.presentation === 'plain') {
    return buildPlainMessage({
      title,
      tone: config.color,
      description: total === 0 ? empty : description,
      sections: fields,
      footer,
      components,
    });
  }

  return {
    embeds: [buildEmbed({
      title,
      tone: config.color,
      description: total === 0 ? empty : description,
      fields,
      footer,
    })],
    components,
  };
};

export const collectionPageMessage = ({ state, sessions, userId }) => {
  const presentation = state?.presentation;
  if (!presentation || !Array.isArray(presentation.items)) {
    throw new TypeError('Collection pagination state is unavailable.');
  }
  return collectionMessage({
    ...presentation,
    collection: normalizeCollection(presentation.items),
    page: state.page,
    sessions,
    userId,
  });
};

export const accountChoices = async (interaction, apiService) => {
  const query = interaction.options.getFocused()?.trim?.() ?? '';
  const data = await apiService.getMyAccounts(actorFromInteraction(interaction), { query, limit: 25 });
  const accounts = normalizeCollection(data).items;
  return accounts.slice(0, 25).map((account) => ({
    name: `${account.name ?? account.label ?? 'Account'}${account.balance_display ? ` · ${account.balance_display}` : ''}`.slice(0, 100),
    value: `${account.token ?? account.id}`.slice(0, 100),
  })).filter((choice) => choice.value && choice.value !== 'undefined');
};

export const executeAutocomplete = async (interaction, apiService, provider = accountChoices) => {
  try {
    await interaction.respond(await provider(interaction, apiService));
  } catch {
    await interaction.respond([]).catch(() => {});
  }
};
