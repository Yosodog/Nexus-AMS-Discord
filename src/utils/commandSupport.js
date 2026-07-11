import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';

export const actorFromInteraction = (interaction) => ({
  discordUserId: interaction.user.id,
  discordGuildId: interaction.guildId,
  discordInteractionId: interaction.id,
});

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
  return messages[error?.code]
    ?? (typeof error?.message === 'string' && error.message.length <= 300 ? error.message : null)
    ?? 'Nexus is unavailable right now. Please try again later.';
};

export const replyError = async (interaction, error, title = 'Request Failed') => {
  const payload = {
    embeds: [new EmbedBuilder()
      .setTitle(title)
      .setColor(0xed4245)
      .setDescription(errorMessage(error))],
    ephemeral: true,
  };
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
  return interaction.reply(payload);
};

export const deferEphemeral = (interaction) => interaction.deferReply({ ephemeral: true });

export const normalizeCollection = (value) => {
  if (Array.isArray(value)) return { items: value, page: 1, pages: 1, total: value.length };
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
  return {
    items,
    page: Number(pagination.current_page ?? pagination.page ?? 1),
    pages: Number(pagination.last_page ?? pagination.pages ?? 1),
    total: Number(pagination.total ?? items.length),
  };
};

const displayScalar = (value) => {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return value.label ?? value.name ?? value.nation_name ?? value.leader_name ?? value.status ?? 'Available';
  return `${value}`;
};

export const summarizeItem = (item, index = 0) => {
  if (typeof item === 'string') return item;
  const title = item?.label ?? item?.name ?? item?.title ?? item?.nation_name ?? `Item ${index + 1}`;
  const interesting = [
    'status', 'type', 'account_name', 'amount', 'remaining_balance', 'eligible', 'cities', 'score',
    'estimated_value', 'turns_left', 'created_at', 'updated_at', 'target', 'reason',
  ];
  const details = interesting
    .filter((key) => item?.[key] !== undefined)
    .slice(0, 4)
    .map((key) => `${key.replaceAll('_', ' ')}: ${displayScalar(item[key])}`);
  if (item?.resources && typeof item.resources === 'object') {
    const resources = Object.entries(item.resources)
      .filter(([, amount]) => Number(amount) !== 0)
      .slice(0, 6)
      .map(([resource, amount]) => `${resource}: ${amount}`);
    if (resources.length) details.push(resources.join(' · '));
  }
  return `**${title}**${details.length ? `\n${details.join(' · ')}` : ''}`;
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
}) => {
  const body = collection.items.length
    ? collection.items.slice(0, 10).map(summarizeItem).join('\n\n').slice(0, 3900)
    : empty;
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(0x5865f2)
    .setDescription(body)
    .setFooter({ text: `Page ${collection.page} of ${Math.max(collection.pages, 1)} · ${collection.total} total` });
  const components = [];
  if (collection.pages > 1 && sessions) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(sessions.create({ commandName, userId, event, state: { ...state, page: collection.page - 1 } }))
        .setLabel('Previous')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(collection.page <= 1),
      new ButtonBuilder()
        .setCustomId(sessions.create({ commandName, userId, event, state: { ...state, page: collection.page + 1 } }))
        .setLabel('Next')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(collection.page >= collection.pages),
    ));
  }
  return { embeds: [embed], components };
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
