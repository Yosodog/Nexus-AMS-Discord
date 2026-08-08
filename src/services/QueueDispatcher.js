import { queueActions } from './queueActions/index.js';
import { QueueActionRuntime } from './queueActions/runtime.js';

/** Stable registry/entrypoint for Nexus queue actions. */
export class QueueDispatcher {
  constructor({ client, logger, guildId, apiService = null, alertLaneEnabled = true }) {
    this.logger = logger;
    this.actions = queueActions;
    this.alertLaneEnabled = alertLaneEnabled;
    this.runtime = new QueueActionRuntime({ client, logger, guildId, apiService });
  }

  /**
   * Validate and execute one queue action.
   * @param {any} command queue item returned by Nexus
   * @param {{ canContinue?: () => boolean }} execution lease-aware execution context
   * @returns {Promise<{ success: boolean, reason?: string }>}
   */
  async dispatch(command, execution = {}) {
    const actionName = command?.action;
    if (!actionName || typeof actionName !== 'string') {
      this.logger.warn('Queue item is missing an action', command?.id ?? 'unknown');
      return { success: false, reason: 'invalid_action' };
    }

    const action = this.actions[actionName];
    if (!action) {
      this.logger.warn(`Unsupported queue action received: ${actionName}`);
      return { success: false, reason: 'unsupported_action' };
    }

    if (actionName === 'ALERT_DELIVERY_V1' && !this.alertLaneEnabled) {
      this.logger.error('Refusing alert-lane work because the renderer manifest is not verified', {
        commandId: command?.id ?? null,
      });
      return {
        success: true,
        result: {
          success: false,
          delivery_id: command?.payload?.delivery_id ?? null,
          delivery: 'quarantined',
          guild_id: null,
          channel_id: null,
          provider_message_id: null,
          error_code: 'alert_manifest_mismatch',
          retryable: false,
        },
      };
    }

    const validation = action.validate(command?.payload);
    if (!validation?.valid) {
      this.logger.warn(`Invalid ${actionName} queue payload`, {
        commandId: command?.id ?? null,
        reason: validation?.reason ?? 'invalid_payload',
      });
      if (action.quarantineOnInvalid) {
        return {
          success: true,
          result: {
            success: false,
            delivery_id: command?.payload?.delivery_id ?? null,
            delivery: 'quarantined',
            guild_id: null,
            channel_id: null,
            provider_message_id: null,
            error_code: validation?.reason ?? 'invalid_payload',
            retryable: false,
          },
        };
      }
      return { success: false, reason: validation?.reason ?? 'invalid_payload' };
    }

    const runtime = this.runtime.forExecution(execution);
    if (!runtime.canContinue()) {
      return { success: false, reason: 'lease_lost' };
    }

    try {
      return await action.execute(command, runtime);
    } catch (error) {
      this.logger.error(`Unhandled error while processing ${actionName}`, error?.message ?? error);
      return { success: false, reason: 'handler_error' };
    }
  }
}
