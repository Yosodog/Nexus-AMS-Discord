import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';

const INTEGER_FORMATTER = new Intl.NumberFormat('en-US');
const MONEY_FORMATTER = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 0,
});

export const data = new SlashCommandBuilder()
  .setName('sweepbank')
  .setDescription('Sweep the main bank into the primary offshore.')
  .addStringOption((option) =>
    option
      .setName('note')
      .setDescription('Optional audit note for the Nexus sweep log.')
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

  if (!memberHasSweepAccess(interaction)) {
    logger.warn('Discord-side sweep access denied', logContext);
    await interaction.reply({
      embeds: [buildErrorEmbed('You are not allowed to run this command.')],
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const response = await apiService.sweepPrimaryOffshore({
      moderator_discord_id: interaction.user.id,
      ...(noteValue ? { note: noteValue } : {}),
    });

    logger.info('Sweep bank request succeeded', {
      ...logContext,
      status: 200,
      swept: Boolean(response?.swept),
      offshoreId: response?.offshore?.id ?? null,
      offshoreName: response?.offshore?.name ?? null,
      transferId: response?.transfer?.id ?? null,
    });

    const embed = response?.swept
      ? buildSuccessEmbed(response)
      : buildNoOpEmbed(response);

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    const { status = null, data = null } = error?.response ?? {};
    logger.error('Sweep bank request failed', {
      ...logContext,
      status,
      backendErrorCode: data?.error ?? null,
      backendMessage: data?.message ?? null,
      error,
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

function memberHasSweepAccess(interaction) {
  const roleIds = getInteractionRoleIds(interaction.member);
  const everyoneRoleId = interaction.guildId ?? null;

  if (!everyoneRoleId) {
    return false;
  }

  return Array.from(roleIds).some((roleId) => roleId !== everyoneRoleId);
}

function getInteractionRoleIds(member) {
  if (!member?.roles) {
    return new Set();
  }

  if (Array.isArray(member.roles)) {
    return new Set(member.roles);
  }

  if (member.roles.cache) {
    return new Set(member.roles.cache.keys());
  }

  return new Set();
}

function buildSuccessEmbed(response) {
  const offshoreName = response?.offshore?.name ?? 'Primary Offshore';
  const transferPayload = response?.transfer?.payload ?? {};
  const resourceSummary = formatResourceSummary(transferPayload);
  const embed = new EmbedBuilder()
    .setTitle('Bank Swept')
    .setColor(0x57f287)
    .setDescription(`Main bank swept into **${offshoreName}**.`)
    .setTimestamp();

  if (resourceSummary !== 'No transferable resources were reported.') {
    embed.addFields({ name: 'Transferred Resources', value: resourceSummary });
  }

  if (response?.transfer?.message) {
    embed.addFields({ name: 'Transfer Status', value: response.transfer.message });
  }

  return embed;
}

function buildNoOpEmbed(response) {
  const offshoreName = response?.offshore?.name ?? 'the primary offshore';

  return new EmbedBuilder()
    .setTitle('No Sweep Needed')
    .setColor(0xfaa61a)
    .setDescription(`The main bank is already empty.\nConfigured offshore: **${offshoreName}**.`)
    .setTimestamp();
}

function buildErrorEmbed(message) {
  return new EmbedBuilder()
    .setTitle('Sweep Failed')
    .setColor(0xed4245)
    .setDescription(message)
    .setTimestamp();
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
    return `$${MONEY_FORMATTER.format(numericValue)}`;
  }

  return INTEGER_FORMATTER.format(numericValue);
}

function humanizeResourceName(resource) {
  return String(resource)
    .split('_')
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}
