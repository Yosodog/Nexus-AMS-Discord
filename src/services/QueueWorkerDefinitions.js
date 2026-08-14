export const QUEUE_LANES = Object.freeze({
  SIDE_EFFECTS: 'side_effects',
  ALERTS: 'alerts',
  DIGESTS: 'digests',
});

export const buildQueueWorkerDefinitions = ({ alertLanesEnabled = false } = {}) => [
  { lane: QUEUE_LANES.SIDE_EFFECTS, enabled: true },
  { lane: QUEUE_LANES.ALERTS, enabled: Boolean(alertLanesEnabled) },
  { lane: QUEUE_LANES.DIGESTS, enabled: Boolean(alertLanesEnabled) },
];
