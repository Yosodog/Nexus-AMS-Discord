import { SlashCommandBuilder } from 'discord.js';
import { actorFromInteraction, deferEphemeral, replyError } from '../utils/commandSupport.js';
import {
  buildEmbed,
  escapeMarkdown,
  formatDiscordTime,
  formatMoney,
  formatNumber,
  markdownLink,
  resolveDeepLink,
  truncate,
} from '../utils/discordUi.js';

export const data = new SlashCommandBuilder()
  .setName('build')
  .setDescription("View your nation's recommended city build from Nexus.")
  .setDMPermission(false);

export const help = Object.freeze({
  audience: 'Members',
  topic: Object.freeze(['member']),
  examples: Object.freeze(['/build']),
  related: Object.freeze(['audit', 'nation']),
});

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const finiteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

const auditLink = (baseUrl, path) => markdownLink(
  'Open Audit Center in Nexus',
  resolveDeepLink(baseUrl, path),
);

const validateBase = (projection) => {
  if (!isRecord(projection)
    || projection.contract_version !== 1
    || !['ready', 'unavailable'].includes(projection.state)
    || !positiveInteger(projection?.nation?.id)
    || typeof projection?.nation?.name !== 'string'
    || projection.nation.name.trim() === ''
    || typeof projection?.deep_link_path !== 'string'
    || !/^\/(?!\/)/.test(projection.deep_link_path)) {
    throw new TypeError('Nexus returned an invalid build recommendation projection.');
  }
};

const validateRecommendation = (recommendation) => {
  const numericKeys = [
    'target_infrastructure',
    'land_used',
    'used_slots',
    'available_slots',
    'cities_below_target',
    'infrastructure_shortfall',
    'converted_profit_per_day',
  ];
  if (!isRecord(recommendation)
    || numericKeys.some((key) => !finiteNumber(recommendation[key]))
    || !Array.isArray(recommendation.groups)
    || recommendation.groups.length > 10) {
    throw new TypeError('Nexus returned an invalid build recommendation projection.');
  }

  for (const group of recommendation.groups) {
    if (!isRecord(group)
      || typeof group.label !== 'string'
      || group.label.trim() === ''
      || !Array.isArray(group.items)
      || group.items.length > 30
      || group.items.some((item) => !isRecord(item)
        || typeof item.label !== 'string'
        || !positiveInteger(item.count))) {
      throw new TypeError('Nexus returned an invalid build recommendation projection.');
    }
  }
};

const groupField = (group) => ({
  name: truncate(escapeMarkdown(group.label), 256),
  value: truncate(
    group.items.map((item) => `${formatNumber(item.count)}× ${escapeMarkdown(item.label)}`).join('\n'),
    1_024,
  ),
  inline: true,
});

export const buildMessage = (projection, baseUrl) => {
  validateBase(projection);
  const nationName = escapeMarkdown(truncate(projection.nation.name, 100));

  if (projection.state === 'unavailable') {
    return {
      embeds: [buildEmbed({
        title: `${truncate(projection.nation.name, 220)} Recommended Build`,
        tone: 'warning',
        description: [
          escapeMarkdown(truncate(projection.message ?? 'No current recommendation is available.', 700)),
          auditLink(baseUrl, projection.deep_link_path),
        ].join('\n\n'),
        footer: 'Build recommendations are generated and authorized by Nexus.',
      })],
      allowedMentions: { parse: [] },
    };
  }

  validateRecommendation(projection.recommendation);
  const recommendation = projection.recommendation;
  const warnings = [];
  if (Number(recommendation.cities_below_target) > 0) {
    warnings.push(
      `${formatNumber(recommendation.cities_below_target)} cities need ${formatNumber(recommendation.infrastructure_shortfall)} total infrastructure to use this build.`,
    );
  }
  if (recommendation.market_stale === true) {
    warnings.push('The market-price inputs were stale when this recommendation was calculated.');
  }

  return {
    embeds: [buildEmbed({
      title: `${truncate(projection.nation.name, 220)} Recommended Build`,
      tone: warnings.length ? 'warning' : 'success',
      description: [
        `Recommended city template for **${nationName}**.`,
        auditLink(baseUrl, projection.deep_link_path),
      ].join('\n'),
      fields: [
        {
          name: 'City target',
          value: `${formatNumber(recommendation.target_infrastructure)} infrastructure\n${formatNumber(recommendation.land_used)} land`,
          inline: true,
        },
        {
          name: 'Improvement slots',
          value: `${formatNumber(recommendation.used_slots)} / ${formatNumber(recommendation.available_slots)} used`,
          inline: true,
        },
        {
          name: 'Estimated daily profit',
          value: formatMoney(recommendation.converted_profit_per_day),
          inline: true,
        },
        ...recommendation.groups.map(groupField),
        warnings.length
          ? { name: 'Attention', value: truncate(warnings.join('\n'), 1_024), inline: false }
          : null,
        recommendation.calculated_at
          ? { name: 'Calculated', value: formatDiscordTime(recommendation.calculated_at), inline: true }
          : null,
      ],
      footer: 'This recommendation is private to your linked Nexus account.',
    })],
    allowedMentions: { parse: [] },
  };
};

export const execute = async (interaction, context) => {
  await deferEphemeral(interaction);
  try {
    const projection = await context.apiService.getMyBuildRecommendation(
      actorFromInteraction(interaction, 'build'),
    );
    await interaction.editReply(buildMessage(projection, context.apiService.baseUrl));
  } catch (error) {
    await replyError(interaction, error, 'Build Recommendation Failed');
  }
};
