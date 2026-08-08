import { Events } from 'discord.js';
import { InteractionSessionStore } from '../services/InteractionSessionStore.js';
import { COLLECTION_PAGE_EVENT, collectionPageMessage } from '../utils/commandSupport.js';
import { config } from '../utils/config.js';
import { statusMessage } from '../utils/discordUi.js';

const interactionKinds = (interaction) => ({
  autocomplete: interaction.isAutocomplete?.(),
  chat: interaction.isChatInputCommand?.(),
  button: interaction.isButton?.(),
  select: interaction.isStringSelectMenu?.()
    || interaction.isUserSelectMenu?.()
    || interaction.isRoleSelectMenu?.()
    || interaction.isChannelSelectMenu?.()
    || interaction.isMentionableSelectMenu?.(),
  modal: interaction.isModalSubmit?.(),
});

const resolutionFailure = async (interaction, kinds, logger, error) => {
  logger.warn('Ignored interaction without an unambiguous Nexus connection', {
    command: interaction.commandName ?? null,
    guildId: interaction.guildId ?? null,
    errorCode: error?.code ?? 'CONNECTION_UNAVAILABLE',
  });
  if (kinds.autocomplete) {
    await interaction.respond?.([]).catch?.(() => {});
  } else if (kinds.chat || kinds.button || kinds.select || kinds.modal) {
    await interaction.reply?.({
      ...statusMessage({
        title: 'Nexus Unavailable',
        tone: 'warning',
        description: 'This Discord guild is not connected to one active Nexus installation.',
      }),
      ephemeral: true,
    }).catch?.(() => {});
  }
};

/**
 * Register the interaction listener. Dedicated mode uses the legacy guild
 * argument; shared mode resolves every interaction through the same explicit
 * application/guild/connection/generation context.
 */
export const registerInteractionListener = (
  client,
  commands,
  logger,
  context = {},
  guildId = context.guildId ?? config.discord.guildId,
) => {
  const sessions = context.sessions ?? new InteractionSessionStore();
  const resolver = context.connectionResolver ?? null;
  const applicationId = context.applicationId ?? client.application?.id ?? config.discord.clientId;

  client.on(Events.InteractionCreate, async (interaction) => {
    const kinds = interactionKinds(interaction);
    if (!Object.values(kinds).some(Boolean)) return;

    let connection = null;
    if (resolver) {
      try {
        connection = resolver.resolveInteraction(interaction, {
          applicationId,
          commandName: kinds.chat || kinds.autocomplete ? interaction.commandName : null,
        });
      } catch (error) {
        await resolutionFailure(interaction, kinds, logger, error);
        return;
      }
    } else if (!guildId || interaction.guildId !== guildId) {
      logger.warn('Ignored interaction outside the configured guild', {
        command: interaction.commandName ?? null,
        guildId: interaction.guildId ?? null,
      });
      if (kinds.autocomplete) await interaction.respond?.([]).catch?.(() => {});
      return;
    }

    const effectiveGuildId = connection?.guildId ?? guildId;
    const scopedSessions = connection ? sessions.forConnection(connection) : sessions;
    const runtimeContext = connection
      ? {
          ...context,
          apiService: connection.apiService
            ?? context.connectionServiceFactory?.(connection)
            ?? context.apiService,
          applicationId: connection.applicationId,
          appId: connection.applicationId,
          guildId: connection.guildId,
          connectionId: connection.connectionId,
          generation: connection.generation,
          keyId: connection.keyId,
          capabilities: connection.capabilities,
          connectionContext: connection,
          sessions: scopedSessions,
        }
      : {
          ...context,
          guildId: effectiveGuildId,
          sessions: scopedSessions,
        };

    let session = null;
    let commandName = interaction.commandName;
    let handler = kinds.autocomplete ? 'autocomplete' : 'execute';
    if (kinds.button || kinds.select || kinds.modal) {
      session = connection
        ? sessions.resolve(interaction.customId, interaction.user?.id, connection)
        : sessions.resolve(interaction.customId, interaction.user?.id);
      commandName = session?.commandName;
      handler = kinds.button ? 'button' : kinds.select ? 'select' : 'modal';
      if (!session) {
        await interaction.reply({
          ...statusMessage({
            title: 'Control Expired',
            tone: 'warning',
            description: 'This control expired or belongs to another Nexus connection. Run the command again to get fresh controls.',
          }),
          ephemeral: true,
        }).catch(() => {});
        return;
      }
    }

    if (kinds.button && session?.event === COLLECTION_PAGE_EVENT) {
      try {
        await interaction.deferUpdate();
        await interaction.editReply(collectionPageMessage({
          state: session.state,
          sessions: scopedSessions,
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
      if (kinds.autocomplete) await interaction.respond?.([]).catch?.(() => {});
      else await interaction.reply?.({
        ...statusMessage({
          title: 'Interaction Unavailable',
          tone: 'warning',
          description: 'This interaction is no longer available. Run the command again.',
        }),
        ephemeral: true,
      }).catch?.(() => {});
      return;
    }

    try {
      interaction.nexusCommandName = commandName;
      if (connection) interaction.nexusConnectionContext = connection;
      await command[handler](interaction, {
        logger,
        ...runtimeContext,
        guildId: effectiveGuildId,
        sessions: scopedSessions,
        session,
      });
    } catch (error) {
      logger.error('Unhandled error executing interaction', {
        command: commandName ?? null,
        handler,
        guildId: interaction.guildId,
        connectionId: connection?.connectionId ?? null,
        generation: connection?.generation ?? null,
        errorMessage: error?.message ?? String(error),
      });

      if (kinds.autocomplete) {
        await interaction.respond?.([]).catch?.(() => {});
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
        await interaction.reply?.({
          ...statusMessage({
            title: 'Command Failed',
            tone: 'danger',
            description: 'Something went wrong while executing that command. Try again in a moment.',
          }),
          ephemeral: true,
        }).catch?.(() => {});
      }
    }
  });
};
