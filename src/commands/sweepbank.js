import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
} from 'discord.js';
import { actorFromInteraction, replyError } from '../utils/commandSupport.js';
import {
  buildEmbed,
  escapeMarkdown,
  formatDiscordTime,
  formatMoney,
  formatNumber,
  markdownLink,
  resolveDeepLink,
  titleCase,
  truncate,
} from '../utils/discordUi.js';

export const data = new SlashCommandBuilder()
  .setName('sweepbank')
  .setDescription('Sweep the main bank into the primary offshore.')
  .addStringOption((option) =>
    option
      .setName('note')
      .setDescription('Optional audit note for the Nexus sweep log.')
      .setMaxLength(255)
      .setRequired(false),
  )
  .setDMPermission(false);

export const help = Object.freeze({
  audience: 'Staff',
  topic: Object.freeze(['finance', 'staff']),
  examples: Object.freeze(['/sweepbank', '/sweepbank note:<note>']),
  related: Object.freeze(['accounts', 'transactions', 'audit']),
});

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ logger: import('../services/Logger.js').Logger, apiService: import('../services/ApiService.js').ApiService }} context
 */
export const execute = async (interaction, { logger, apiService, sessions }) => {
  const moderatorId = interaction.user?.id ?? null;
  const note = interaction.options.getString('note')?.trim() ?? '';
  const noteValue = note.length > 0 ? note : undefined;
  const logContext = {
    command: 'sweepbank',
    moderatorId,
    guildId: interaction.guildId ?? null,
    channelId: interaction.channelId ?? null,
  };

  if (!interaction.inGuild()) {
    await interaction.reply({
      embeds: [buildErrorEmbed('This command must be used inside a server.')],
      ephemeral: true,
    });
    return;
  }

  if (!apiService?.previewPrimaryOffshoreSweep || !sessions) {
    logger.error('ApiService unavailable for /sweepbank', logContext);
    await interaction.reply({
      embeds: [buildErrorEmbed('Sweep service unavailable. Please try again later.')],
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const response = await apiService.previewPrimaryOffshoreSweep(
      actorFromInteraction(interaction, 'sweepbank'),
      noteValue ? { note: noteValue } : {},
    );

    logger.info('Sweep bank request succeeded', {
      ...logContext,
      status: 201,
      sweepRequired: response?.sweep_required === true,
      offshoreId: response?.summary?.offshore?.id ?? null,
      offshoreName: response?.summary?.offshore?.name ?? null,
    });

    const summary = response?.summary ?? {};
    if (response?.sweep_required !== true) {
      await interaction.editReply({
        embeds: [buildNoOpEmbed(summary, apiService.baseUrl)],
        allowedMentions: { parse: [] },
      });
      return;
    }
    const intentId = `${response?.intent?.id ?? ''}`;
    if (!/^[a-zA-Z0-9]{64}$/.test(intentId)) {
      throw new TypeError('Nexus returned an invalid bank sweep confirmation token.');
    }
    const confirmId = sessions.create({
      commandName: 'sweepbank',
      userId: interaction.user.id,
      event: 'confirm',
      state: { intentId },
      oneShot: true,
    });
    const warnings = Array.isArray(response?.warnings)
      ? response.warnings.filter((warning) => typeof warning === 'string' && warning.trim() !== '')
      : [];
    await interaction.editReply({
      embeds: [buildEmbed({
        title: 'Review Main Bank Sweep',
        tone: 'warning',
        description: truncate(summary.description ?? 'Confirm to sweep these refreshed balances.', 1_200),
        fields: [
          {
            name: 'Destination',
            value: escapeMarkdown(truncate(summary?.offshore?.name ?? 'Primary Offshore', 100)),
            inline: true,
          },
          {
            name: 'Alliance',
            value: summary?.offshore?.alliance_id ? `#${summary.offshore.alliance_id}` : 'Unknown',
            inline: true,
          },
          { name: 'Resources', value: formatResourceSummary(summary.resources ?? {}) },
          summary.note
            ? { name: 'Audit note', value: escapeMarkdown(truncate(summary.note, 500)) }
            : null,
          response?.intent?.expires_at
            ? { name: 'Confirmation expires', value: formatDiscordTime(response.intent.expires_at), inline: true }
            : null,
          warnings.length
            ? { name: 'Nexus warning', value: escapeMarkdown(truncate(warnings.join('\n'), 1_000)) }
            : null,
        ],
        footer: 'Nexus will refresh balances, permission, and destination again when you confirm.',
      })],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(confirmId)
          .setLabel('Confirm bank sweep')
          .setStyle(ButtonStyle.Danger),
      )],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    logger.error('Sweep bank request failed', {
      ...logContext,
      status: error?.status ?? error?.response?.status ?? null,
      backendErrorCode: error?.code ?? null,
    });
    await replyError(interaction, error, 'Sweep Preview Failed');
  }
};

export const button = async (interaction, context) => {
  await interaction.deferUpdate();
  try {
    if (context.session?.event !== 'confirm') {
      throw new TypeError('This bank sweep confirmation is invalid or expired.');
    }
    const intentId = `${context.session?.state?.intentId ?? ''}`;
    if (!/^[a-zA-Z0-9]{64}$/.test(intentId)) {
      throw new TypeError('This bank sweep confirmation is invalid or expired.');
    }
    const response = await context.apiService.confirmPrimaryOffshoreSweep(
      actorFromInteraction(interaction, 'sweepbank'),
      { intent_id: intentId },
    );
    if (response?.reconciliation_required === true) {
      await interaction.editReply({
        embeds: [buildErrorEmbed('Nexus recorded an ambiguous bank response. Do not retry; reconcile this transfer in Nexus.')],
        components: [],
        allowedMentions: { parse: [] },
      });
      return;
    }
    if (response?.swept !== true || !response?.transfer?.id) {
      throw new TypeError('Nexus returned an invalid bank sweep result.');
    }
    await interaction.editReply({
      embeds: [buildSuccessEmbed(response, context.apiService.baseUrl)],
      components: [],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    context.logger?.error?.('Sweep bank confirmation failed', {
      command: 'sweepbank',
      guildId: interaction.guildId,
      moderatorId: interaction.user?.id ?? null,
      status: error?.status ?? error?.response?.status ?? null,
      backendErrorCode: error?.code ?? null,
    });
    await replyError(interaction, error, 'Sweep Confirmation Failed');
  }
};

function buildSuccessEmbed(response, baseUrl) {
  const offshoreName = response?.offshore?.name ?? 'Primary Offshore';
  const transferPayload = response?.transfer?.payload ?? {};
  const resourceSummary = formatResourceSummary(transferPayload);
  const offshoreUrl = resolveDeepLink(
    baseUrl,
    response?.offshore?.deep_link_path ?? response?.offshore?.url,
  );

  return buildEmbed({
    title: 'Bank Swept',
    tone: 'success',
    description: `Main bank swept into **${markdownLink(truncate(offshoreName, 100), offshoreUrl)}**.`,
    fields: [
      resourceSummary !== 'No transferable resources were reported.'
        ? { name: 'Transferred Resources', value: resourceSummary }
        : null,
      response?.transfer?.message
        ? { name: 'Transfer Status', value: escapeMarkdown(truncate(response.transfer.message, 1_024)) }
        : null,
      response?.transfer?.id
        ? { name: 'Transfer', value: `#${response.transfer.id}`, inline: true }
        : null,
      response?.transfer?.created_at || response?.transfer?.completed_at
        ? {
          name: 'Completed',
          value: formatDiscordTime(response.transfer.completed_at ?? response.transfer.created_at),
          inline: true,
        }
        : null,
    ],
    footer: 'The sweep was recorded in the Nexus audit log.',
    timestamp: true,
  });
}

function buildNoOpEmbed(response, baseUrl) {
  const offshoreName = response?.offshore?.name ?? 'the primary offshore';
  const offshoreUrl = resolveDeepLink(
    baseUrl,
    response?.offshore?.deep_link_path ?? response?.offshore?.url,
  );

  return buildEmbed({
    title: 'No Sweep Needed',
    tone: 'warning',
    description: `The main bank is already empty.\nConfigured offshore: **${markdownLink(truncate(offshoreName, 100), offshoreUrl)}**.`,
    footer: 'No transfer was created.',
    timestamp: true,
  });
}

function buildErrorEmbed(message) {
  return buildEmbed({
    title: 'Sweep Failed',
    tone: 'danger',
    description: truncate(message, 4_096),
    footer: 'Review the Nexus error before retrying.',
    timestamp: true,
  });
}

function formatResourceSummary(payload) {
  const entries = Object.entries(payload)
    .filter(([, value]) => Number(value) > 0)
    .map(([resource, value]) => `${humanizeResourceName(resource)}: ${formatResourceValue(resource, value)}`);

  return entries.length > 0 ? entries.join('\n') : 'No transferable resources were reported.';
}

function formatResourceValue(resource, value) {
  const numericValue = Number(value);

  if (resource === 'money') {
    return formatMoney(numericValue);
  }

  return formatNumber(numericValue, { maximumFractionDigits: 3 });
}

function humanizeResourceName(resource) {
  return titleCase(resource);
}
