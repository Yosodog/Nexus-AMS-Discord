import { SlashCommandBuilder } from 'discord.js';
import { actorFromInteraction } from '../utils/commandSupport.js';
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
      .setMaxLength(500)
      .setRequired(false),
  )
  .setDMPermission(false);

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ logger: import('../services/Logger.js').Logger, apiService: import('../services/ApiService.js').ApiService }} context
 */
export const execute = async (interaction, { logger, apiService }) => {
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

  if (!apiService?.sweepPrimaryOffshore) {
    logger.error('ApiService unavailable for /sweepbank', logContext);
    await interaction.reply({
      embeds: [buildErrorEmbed('Sweep service unavailable. Please try again later.')],
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const response = await apiService.sweepPrimaryOffshore(
      {
        moderator_discord_id: interaction.user.id,
        request_id: interaction.id,
        ...(noteValue ? { note: noteValue } : {}),
      },
      actorFromInteraction(interaction, 'sweepbank'),
    );

    logger.info('Sweep bank request succeeded', {
      ...logContext,
      status: 200,
      swept: Boolean(response?.swept),
      offshoreId: response?.offshore?.id ?? null,
      offshoreName: response?.offshore?.name ?? null,
      transferId: response?.transfer?.id ?? null,
    });

    const embed = response?.swept
      ? buildSuccessEmbed(response, apiService.baseUrl)
      : buildNoOpEmbed(response, apiService.baseUrl);

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    const { status = null, data = null } = error?.response ?? {};
    logger.error('Sweep bank request failed', {
      ...logContext,
      status,
      backendErrorCode: data?.error ?? null,
      backendMessage: data?.message ?? null,
    });

    if (status === 403 && data?.error === 'moderator_not_found') {
      await interaction.editReply({
        embeds: [buildErrorEmbed('Your Discord account is not linked to Nexus.')],
      });
      return;
    }

    if (status === 403) {
      await interaction.editReply({
        embeds: [buildErrorEmbed('Your Discord account is not authorized to sweep the bank in Nexus.')],
      });
      return;
    }

    if (status === 409 && data?.error === 'sweep_reconciliation_required') {
      await interaction.editReply({
        embeds: [buildErrorEmbed('Nexus could not safely determine the prior sweep result. Staff must reconcile it before retrying.')],
      });
      return;
    }

    if (status === 422) {
      await interaction.editReply({
        embeds: [buildErrorEmbed(`The sweep request failed: ${data?.message ?? 'Unknown error.'}`)],
      });
      return;
    }

    await interaction.editReply({
      embeds: [buildErrorEmbed('A temporary error prevented the bank sweep. Please try again shortly.')],
    });
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
    footer: 'No additional Discord confirmation is required before retrying.',
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
