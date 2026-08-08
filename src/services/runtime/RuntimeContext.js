import { createDeliveryContext } from '../connection/ConnectionContext.js';

export const createInteractionRuntimeContext = ({
  interaction,
  connection,
  apiService = connection?.apiService ?? null,
  sessions,
  commandName = interaction?.commandName ?? null,
} = {}) => {
  if (!connection?.connectionId) throw new TypeError('Interaction runtime requires a resolved connection.');
  const context = {
    applicationId: connection.applicationId,
    appId: connection.applicationId,
    guildId: connection.guildId,
    connectionId: connection.connectionId,
    generation: connection.generation,
    keyId: connection.keyId,
    protocolVersion: connection.protocolVersion,
    capabilities: connection.capabilities,
    connectionContext: connection,
    apiService,
    sessions,
    commandName,
    deliveryContext: null,
  };
  if (interaction) interaction.nexusConnectionContext = connection;
  return Object.freeze(context);
};

export const createQueueExecutionContext = ({
  connection,
  item,
  workerId,
  claimRequestId,
  canContinue,
} = {}) => {
  const deliveryContext = createDeliveryContext(connection, item);
  return Object.freeze({
    connectionContext: connection,
    applicationId: connection.applicationId,
    guildId: connection.guildId,
    connectionId: connection.connectionId,
    generation: connection.generation,
    keyId: connection.keyId,
    deliveryContext,
    workerId,
    claimRequestId,
    canContinue,
  });
};

export const scopedDedupeKey = ({ connectionId, generation, dedupeKey, deliveryId } = {}) => {
  const id = `${connectionId ?? ''}`.trim().toLowerCase();
  const generationValue = Number(generation);
  const key = `${dedupeKey ?? deliveryId ?? ''}`.trim();
  if (!id || !Number.isSafeInteger(generationValue) || generationValue < 1 || !key) {
    throw new TypeError('A dedupe key requires connection id, generation, and a key value.');
  }
  return `${id}:${generationValue}:${key}`;
};
