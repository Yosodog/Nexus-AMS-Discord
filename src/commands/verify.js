import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
} from 'discord.js';
import {
  actorFromInteraction,
  deferEphemeral,
  replyError,
} from '../utils/commandSupport.js';
import {
  buildEmbed,
  escapeMarkdown,
  formatDiscordTime,
  statusMessage,
  truncate,
} from '../utils/discordUi.js';

const VERIFICATION_CODE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const data = new SlashCommandBuilder()
  .setName('verify')
  .setDescription('Link this Discord account to Nexus with a verification code.')
  .addStringOption((option) =>
    option
      .setName('code')
      .setDescription('Verification code from your Nexus account settings.')
      .setMinLength(36)
      .setMaxLength(36)
      .setRequired(true),
  )
  .setDMPermission(false);

export const help = Object.freeze({
  audience: 'Everyone',
  topic: Object.freeze(['getting-started']),
  examples: Object.freeze(['/verify code:<verification-code>']),
  related: Object.freeze(['me', 'help']),
});

export const execute = async (interaction, { logger, apiService, sessions }) => {
  const code = `${interaction.options.getString('code', true)}`.trim().toLowerCase();
  if (!VERIFICATION_CODE.test(code)) {
    await interaction.reply({
      ...statusMessage({
        title: 'Verification Issue',
        tone: 'danger',
        description: 'Copy the complete verification code from your Nexus account settings.',
      }),
      ephemeral: true,
    });
    return;
  }

  await deferEphemeral(interaction);
  try {
    if (!apiService || !sessions) {
      throw new TypeError('The Nexus verification service is unavailable.');
    }
    const preview = await apiService.previewAccountLink(
      actorFromInteraction(interaction, 'verify'),
      {
        token: code,
        discord_username: interaction.user.globalName
          ?? interaction.user.tag
          ?? interaction.user.username,
      },
    );
    const intentId = `${preview?.intent?.id ?? ''}`;
    if (!/^[a-zA-Z0-9]{64}$/.test(intentId)) {
      throw new TypeError('Nexus returned an invalid account-link confirmation token.');
    }

    const confirmId = sessions.create({
      commandName: 'verify',
      userId: interaction.user.id,
      event: 'confirm',
      state: { intentId },
      oneShot: true,
    });
    const nation = preview?.summary?.nation;
    const warnings = Array.isArray(preview?.warnings)
      ? preview.warnings.filter((value) => typeof value === 'string' && value.trim() !== '')
      : [];

    await interaction.editReply({
      embeds: [buildEmbed({
        title: 'Review Nexus Account Link',
        tone: 'warning',
        description: truncate(
          preview?.summary?.description
            ?? 'Confirm to link this Discord account to Nexus.',
          1_200,
        ),
        fields: [
          nation?.id ? { name: 'Nation', value: `#${nation.id}`, inline: true } : null,
          nation?.name
            ? { name: 'Name', value: escapeMarkdown(truncate(nation.name, 100)), inline: true }
            : null,
          nation?.leader_name
            ? { name: 'Leader', value: escapeMarkdown(truncate(nation.leader_name, 100)), inline: true }
            : null,
          preview?.intent?.expires_at
            ? { name: 'Confirmation expires', value: formatDiscordTime(preview.intent.expires_at), inline: true }
            : null,
          warnings.length > 0
            ? { name: 'Warning', value: truncate(warnings.join('\n'), 1_000), inline: false }
            : null,
        ],
        footer: 'The code is one-time. Nexus will revalidate it when you confirm.',
      })],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(confirmId)
          .setLabel('Link account')
          .setStyle(ButtonStyle.Success),
      )],
    });
  } catch (error) {
    logger?.warn?.('Nexus rejected /verify preview', {
      command: 'verify',
      guildId: interaction.guildId,
      userId: interaction.user.id,
      errorCode: error?.code ?? null,
      status: error?.status ?? null,
    });
    await replyError(interaction, error, 'Verification Preview Failed');
  }
};

export const button = async (interaction, context) => {
  await interaction.deferUpdate();
  try {
    if (context.session?.event !== 'confirm') {
      throw new TypeError('This verification control is no longer supported.');
    }
    const intentId = `${context.session?.state?.intentId ?? ''}`;
    if (!/^[a-zA-Z0-9]{64}$/.test(intentId)) {
      throw new TypeError('This verification confirmation is invalid or expired.');
    }

    const result = await context.apiService.confirmAccountLink(
      actorFromInteraction(interaction, 'verify'),
      { intent_id: intentId },
    );
    if (result?.linked !== true || !result?.discord_user_id) {
      throw new TypeError('Nexus returned an invalid account-link result.');
    }

    await interaction.editReply(statusMessage({
      title: 'Nexus Account Linked',
      tone: 'success',
      description: result?.nation?.id
        ? `This Discord account is now linked to Nexus nation #${result.nation.id}.`
        : 'This Discord account is now linked to Nexus.',
      fields: [
        result?.nation?.name
          ? { name: 'Nation', value: escapeMarkdown(truncate(result.nation.name, 100)), inline: true }
          : null,
        result?.nation?.leader_name
          ? { name: 'Leader', value: escapeMarkdown(truncate(result.nation.leader_name, 100)), inline: true }
          : null,
        result?.linked_at
          ? { name: 'Linked', value: formatDiscordTime(result.linked_at), inline: true }
          : null,
      ],
      footer: 'Run /me to review your Nexus identity and profile-sync status.',
      timestamp: true,
    }));
  } catch (error) {
    context.logger?.warn?.('Nexus rejected /verify confirmation', {
      command: 'verify',
      guildId: interaction.guildId,
      userId: interaction.user.id,
      errorCode: error?.code ?? null,
      status: error?.status ?? null,
    });
    await replyError(interaction, error, 'Verification Failed');
  }
};
