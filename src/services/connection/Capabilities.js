import { queueActions } from '../queueActions/index.js';

export const PHASE2_CAPABILITIES = Object.freeze({
  RELAY_PROOF_V2: 'relay.proof.v2',
  QUEUE_LEASES_V1: 'queue.leases.v1',
  QUEUE_CONNECTION_CONTEXT_V1: 'queue.connection-context.v1',
  STATUS_PROVIDER_DIAGNOSTICS_V1: 'status.provider-diagnostics.v1',
});

export const PHASE2_CAPABILITY_KEYS = Object.freeze(Object.values(PHASE2_CAPABILITIES));

// Every service proof emitted by ApiService in the v2 runtime must be
// explicitly endorsed here. Interaction proofs remain action-specific.
export const V2_SERVICE_PROOF_ACTIONS = Object.freeze([
  'queue.claim',
  'queue.lease',
  'queue.checkpoint',
  'queue.acknowledge',
  'alerts.manifest',
  'war-counters.attach-channel',
  'milcom.objectives.attach-room',
  'applications.message',
  'intel.report',
]);

/** The registry is the source of truth; future queue action integrations appear automatically. */
export const registeredQueueActions = () => Object.freeze(Object.keys(queueActions).sort());

export const hasCapability = (capabilities, key) => {
  const advertised = capabilities?.capabilities
    ?? capabilities?.keys
    ?? capabilities?.features
    ?? capabilities;
  if (Array.isArray(advertised)) return advertised.includes(key);
  if (advertised && typeof advertised === 'object') return advertised[key] === true || advertised[key] === 1;
  return false;
};

export const capabilitySnapshot = (capabilities = {}) => ({
  keys: PHASE2_CAPABILITY_KEYS.filter((key) => hasCapability(capabilities, key)),
  supported_queue_actions: registeredQueueActions(),
  queue_lanes: capabilities?.queue_lanes === true || capabilities?.features?.queue_lanes === true,
});
