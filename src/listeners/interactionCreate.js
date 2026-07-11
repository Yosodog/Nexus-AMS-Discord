import { Events } from 'discord.js';
import { InteractionSessionStore } from '../services/InteractionSessionStore.js';
import { config } from '../utils/config.js';

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
        await interaction.reply({ content: 'This control expired or belongs to another user. Run the command again.', ephemeral: true }).catch(() => {});
        return;
      }
    }

    const command = commands.get(commandName);

    if (!command || typeof command[handler] !== 'function') {
      logger.warn('Received unsupported interaction', { command: commandName ?? null, handler });
      if (isAutocomplete) await interaction.respond([]).catch(() => {});
      else await interaction.reply({ content: 'This interaction is no longer available.', ephemeral: true }).catch(() => {});
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
        const responder = interaction.isMessageComponent?.() || isModal ? 'editReply' : 'followUp';
        await interaction[responder]({
          content: 'Something went wrong while executing that command.',
          ephemeral: true,
          components: [],
        }).catch(() => {});
      } else {
        await interaction
          .reply({ content: 'Something went wrong while executing that command.', ephemeral: true })
          .catch(() => {});
      }
    }
  });
};
