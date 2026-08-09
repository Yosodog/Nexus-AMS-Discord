import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import {
  allianceUrl,
  buildEmbed,
  escapeMarkdown,
  formatDiscordTime,
  formatNumber,
  markdownLink,
  nationUrl,
  resolveDeepLink,
  titleCase,
  truncate,
} from './discordUi.js';

const integer = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0
  ? Number(value)
  : null;

const freshnessField = (freshness) => {
  const state = ['fresh', 'stale', 'unknown'].includes(freshness?.state) ? freshness.state : 'unknown';
  const source = freshness?.source_updated_at;
  return {
    name: state === 'stale' ? 'Source data (stale)' : 'Source data',
    value: source ? formatDiscordTime(source) : 'Update time unavailable',
    inline: true,
  };
};

export const identityMessage = (identity, baseUrl) => {
  if (identity?.contract_version !== 1 || !['ready', 'unlinked', 'ambiguous', 'unavailable'].includes(identity?.state)) {
    throw new TypeError('Nexus returned an invalid identity projection.');
  }
  if (identity.state !== 'ready') {
    return {
      embeds: [buildEmbed({
        title: 'Nexus Identity',
        tone: 'warning',
        description: escapeMarkdown(truncate(identity.message ?? 'No available Nexus identity was found.', 1_000)),
      })],
      allowedMentions: { parse: [] },
    };
  }

  const nationId = integer(identity?.nation?.id);
  if (!nationId || typeof identity?.nation?.name !== 'string') {
    throw new TypeError('Nexus returned an incomplete identity projection.');
  }
  const nexusUrl = resolveDeepLink(baseUrl, identity.deep_link_path);
  return {
    embeds: [buildEmbed({
      title: 'Nexus Identity',
      tone: 'info',
      description: `**${markdownLink(identity.display_name ?? identity.nation.leader_name, nexusUrl)}**`,
      fields: [
        {
          name: 'Nation',
          value: markdownLink(identity.nation.name, nationUrl({ id: nationId })),
          inline: true,
        },
        identity.alliance?.id && identity.alliance?.name
          ? {
            name: 'Alliance',
            value: markdownLink(identity.alliance.name, allianceUrl({ id: identity.alliance.id })),
            inline: true,
          }
          : null,
        identity.discord_username
          ? { name: 'Linked Discord', value: escapeMarkdown(truncate(identity.discord_username, 100)), inline: true }
          : null,
        freshnessField(identity.freshness),
      ],
      footer: 'Identity and visibility are determined by Nexus.',
    })],
    allowedMentions: { parse: [] },
  };
};

export const nationMessage = (nation) => {
  const nationId = integer(nation?.id);
  if (nation?.contract_version !== 1 || nation?.kind !== 'nation' || !nationId || typeof nation?.name !== 'string') {
    throw new TypeError('Nexus returned an invalid nation projection.');
  }
  return {
    embeds: [buildEmbed({
      title: truncate(nation.name, 256),
      tone: nation?.freshness?.state === 'stale' ? 'warning' : 'info',
      description: markdownLink(`Politics & War nation #${nationId}`, nationUrl({ id: nationId })),
      fields: [
        { name: 'Leader', value: escapeMarkdown(truncate(nation.leader_name ?? 'Unknown', 100)), inline: true },
        nation.alliance?.id && nation.alliance?.name
          ? { name: 'Alliance', value: markdownLink(nation.alliance.name, allianceUrl({ id: nation.alliance.id })), inline: true }
          : { name: 'Alliance', value: 'None', inline: true },
        { name: 'Cities', value: formatNumber(Number(nation.cities) || 0), inline: true },
        { name: 'Score', value: formatNumber(Number(nation.score) || 0, { maximumFractionDigits: 2 }), inline: true },
        { name: 'Position', value: titleCase(nation.alliance_position ?? 'none'), inline: true },
        { name: 'Color', value: escapeMarkdown(titleCase(nation.color ?? 'unknown')), inline: true },
        Number(nation.vacation_mode_turns) > 0
          ? { name: 'Vacation mode', value: `${formatNumber(nation.vacation_mode_turns)} turns`, inline: true }
          : null,
        freshnessField(nation.freshness),
      ],
      footer: nation?.freshness?.state === 'stale'
        ? 'Nexus marked this cached projection stale.'
        : 'Public-safe projection supplied by Nexus.',
    })],
    allowedMentions: { parse: [] },
  };
};

export const allianceMessage = (alliance) => {
  const allianceId = integer(alliance?.id);
  if (alliance?.contract_version !== 1 || alliance?.kind !== 'alliance' || !allianceId || typeof alliance?.name !== 'string') {
    throw new TypeError('Nexus returned an invalid alliance projection.');
  }
  return {
    embeds: [buildEmbed({
      title: truncate(alliance.name, 256),
      tone: alliance?.freshness?.state === 'stale' ? 'warning' : 'info',
      description: markdownLink(`Politics & War alliance #${allianceId}`, allianceUrl({ id: allianceId })),
      fields: [
        { name: 'Acronym', value: escapeMarkdown(truncate(alliance.acronym ?? 'Unknown', 20)), inline: true },
        { name: 'Rank', value: `#${formatNumber(Number(alliance.rank) || 0)}`, inline: true },
        { name: 'Nations', value: formatNumber(Number(alliance.nation_count) || 0), inline: true },
        { name: 'Score', value: formatNumber(Number(alliance.score) || 0, { maximumFractionDigits: 2 }), inline: true },
        { name: 'Average score', value: formatNumber(Number(alliance.average_score) || 0, { maximumFractionDigits: 2 }), inline: true },
        { name: 'Accepting members', value: alliance.accepting_members === true ? 'Yes' : 'No', inline: true },
        { name: 'Color', value: escapeMarkdown(titleCase(alliance.color ?? 'unknown')), inline: true },
        freshnessField(alliance.freshness),
      ],
      footer: alliance?.freshness?.state === 'stale'
        ? 'Nexus marked this cached projection stale.'
        : 'Public-safe projection supplied by Nexus.',
    })],
    allowedMentions: { parse: [] },
  };
};

export const shareButton = (sessions, interaction, commandName, entityId) => {
  const customId = sessions.create({
    commandName,
    userId: interaction.user.id,
    event: 'share',
    state: { entityId: `${entityId}` },
    oneShot: true,
  });
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(customId)
      .setLabel('Share public summary')
      .setStyle(ButtonStyle.Secondary),
  );
};
