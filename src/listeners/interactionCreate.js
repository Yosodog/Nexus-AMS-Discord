import { Events } from 'discord.js';
import { InteractionSessionStore } from '../services/InteractionSessionStore.js';
import { COLLECTION_PAGE_EVENT, collectionPageMessage } from '../utils/commandSupport.js';
import { config } from '../utils/config.js';
import { statusMessage } from '../utils/discordUi.js';

/**
 * Register the interactionCreate listener responsible for dispatching slash commands.
 * @param {import('discord.js').Client} client Discord client instance
 * @param {import('discord.js').Collection<string, any>} commands loaded command modules
 * @param {import('../services/Logger.js').Logger} logger structured logger
 * @param {object} context shared dependency container injected into commands
 */
export const registerInteractionListener = (
  client,
  commands,
  logger,
  context = {},
  guildId = context.guildId ?? config.discord.guildId,
) => {
  const sessions = context.sessions ?? new InteractionSessionStore();
  client.on(Events.InteractionCreate, async (interaction) => {
    const isAutocomplete = interaction.isAutocomplete?.();
    const isChat = interaction.isChatInputCommand?.();
    const isButton = interaction.isButton?.();
    const isSelect = interaction.isStringSelectMenu?.()
      || interaction.isUserSelectMenu?.()
      || interaction.isRoleSelectMenu?.()
      || interaction.isChannelSelectMenu?.()
      || interaction.isMentionableSelectMenu?.();
    const isModal = interaction.isModalSubmit?.();
    if (!isAutocomplete && !isChat && !isButton && !isSelect && !isModal) {
      return;
    }

    if (!guildId || interaction.guildId !== guildId) {
      logger.warn('Ignored interaction outside the configured guild', {
        command: interaction.commandName ?? null,
        guildId: interaction.guildId ?? null,
      });
      if (isAutocomplete) await interaction.respond([]).catch(() => {});
      return;
    }

    let session = null;
    let commandName = interaction.commandName;
    let handler = isAutocomplete ? 'autocomplete' : 'execute';
    if (isButton || isSelect || isModal) {
      session = sessions.resolve(interaction.customId, interaction.user?.id);
      commandName = session?.commandName;
      handler = isButton ? 'button' : isSelect ? 'select' : 'modal';
      if (!session) {
        await interaction.reply({
          ...statusMessage({
            title: 'Control Expired',
            tone: 'warning',
            description: 'This control expired or belongs to another user. Run the command again to get fresh controls.',
          }),
          ephemeral: true,
        }).catch(() => {});
        return;
      }
    }

    if (isButton && session?.event === COLLECTION_PAGE_EVENT) {
      try {
        await interaction.deferUpdate();
        await interaction.editReply(collectionPageMessage({
          state: session.state,
          sessions,
          userId: interaction.user.id,
        }));
      } catch (error) {
        logger.error('Failed to render a collection page', {
          command: commandName ?? null,
          guildId: interaction.guildId,
          errorMessage: error?.message ?? String(error),
        });
        const payload = statusMessage({
          title: 'Page Unavailable',
          tone: 'danger',
          description: 'That page could not be displayed. Run the command again to refresh the results.',
        });
        if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => {});
        else await interaction.reply({ ...payload, ephemeral: true }).catch(() => {});
      }
      return;
    }

    const command = commands.get(commandName);

    if (!command || typeof command[handler] !== 'function') {
      logger.warn('Received unsupported interaction', { command: commandName ?? null, handler });
      if (isAutocomplete) await interaction.respond([]).catch(() => {});
      else await interaction.reply({
        ...statusMessage({
          title: 'Interaction Unavailable',
          tone: 'warning',
          description: 'This interaction is no longer available. Run the command again.',
        }),
        ephemeral: true,
      }).catch(() => {});
      return;
    }

    try {
      await command[handler](interaction, {
        logger,
        ...context,
        guildId,
        sessions,
        session,
      });
    } catch (error) {
      logger.error('Unhandled error executing interaction', {
        command: commandName ?? null,
        handler,
        guildId: interaction.guildId,
        errorMessage: error?.message ?? String(error),
      });

      if (isAutocomplete) {
        await interaction.respond([]).catch(() => {});
        return;
      }
      if (interaction.replied || interaction.deferred) {
        const responder = interaction.deferred && !interaction.replied ? 'editReply' : 'followUp';
        await interaction[responder]({
          ...statusMessage({
            title: 'Command Failed',
            tone: 'danger',
            description: 'Something went wrong while executing that command. Try again in a moment.',
          }),
          ephemeral: true,
        }).catch(() => {});
      } else {
        await interaction
          .reply({
            ...statusMessage({
              title: 'Command Failed',
              tone: 'danger',
              description: 'Something went wrong while executing that command. Try again in a moment.',
            }),
            ephemeral: true,
          })
          .catch(() => {});
      }
    }
  });
};
