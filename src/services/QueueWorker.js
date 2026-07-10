import { randomUUID } from 'node:crypto';

const DEFAULT_LEASE_MS = 5 * 60 * 1000;

/**
 * Claims and processes one leased Nexus queue item at a time.
 * A new claim is never made while the prior item is awaiting acknowledgement.
 */
export class QueueWorker {
  constructor({
    apiService,
    dispatcher,
    logger,
    pollIntervalMs = 5000,
    maxBackoffMs = 5 * 60 * 1000,
    leaseRenewIntervalMs = 60 * 1000,
    acknowledgementBackoffMs = 1000,
    leaseSafetyMs = 5000,
    workerId = randomUUID(),
    createRequestId = randomUUID,
  }) {
    this.apiService = apiService;
    this.dispatcher = dispatcher;
    this.logger = logger;
    this.pollIntervalMs = pollIntervalMs;
    this.currentPollIntervalMs = pollIntervalMs;
    this.maxBackoffMs = maxBackoffMs;
    this.leaseRenewIntervalMs = leaseRenewIntervalMs;
    this.acknowledgementBackoffMs = acknowledgementBackoffMs;
    this.leaseSafetyMs = leaseSafetyMs;
    this.workerId = workerId;
    this.createRequestId = createRequestId;

    this.pollTimer = null;
    this.polling = false;
    this.pollPromise = null;
    this.backoffAttempts = 0;
    this.started = false;
    this.stopped = false;
    this.currentWork = null;
    this.activeLease = null;
    this.leaseTimer = null;
    this.leaseRenewing = false;
  }

  start() {
    if (this.started || this.stopped) {
      return;
    }

    this.started = true;
    this.logger.info('Starting leased Nexus queue worker', { workerId: this.workerId });
    this.#scheduleNextPoll(0);
  }

  /** Permanently stop new claims and wait briefly for the active item to finish and acknowledge. */
  async stop({ timeoutMs = 25_000 } = {}) {
    if (this.stopped) {
      return { drained: !(this.currentWork ?? this.pollPromise) };
    }

    this.stopped = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    const drainingWork = this.currentWork ?? this.pollPromise;
    if (!drainingWork) {
      this.#stopLeaseRenewal();
      this.logger.info('Queue worker stopped', { workerId: this.workerId, drained: true });
      return { drained: true };
    }

    let timeout;
    const drained = await Promise.race([
      drainingWork.then(() => true, () => true),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
      }),
    ]);
    clearTimeout(timeout);

    if (!drained) {
      this.#stopLeaseRenewal();
    }
    this.logger.info('Queue worker stopped', { workerId: this.workerId, drained });
    return { drained };
  }

  async #poll() {
    this.pollTimer = null;
    if (this.stopped || this.polling) {
      return;
    }

    this.polling = true;
    let nextDelay = this.pollIntervalMs;

    try {
      const requestId = this.createRequestId();
      const response = await this.apiService.claimDiscordQueue(this.workerId, requestId);
      const item = response?.data ?? null;
      this.#resetBackoff();

      if (!item) {
        this.logger.debug('No leased Discord command available', {
          workerId: this.workerId,
          claimRequestId: requestId,
        });
      } else {
        this.currentWork = this.#processItem(item, requestId);
        await this.currentWork;
        nextDelay = 0;
      }
    } catch (error) {
      this.#increaseBackoff();
      nextDelay = this.currentPollIntervalMs;
      this.logger.warn('Failed to claim Nexus Discord queue item', {
        workerId: this.workerId,
        status: error?.response?.status ?? null,
        errorCode: error?.code ?? null,
      });
    } finally {
      this.currentWork = null;
      this.polling = false;
      this.#scheduleNextPoll(nextDelay);
    }
  }

  async #processItem(item, claimRequestId) {
    if (!item?.id || !item?.lease_token) {
      this.logger.error('Claim response missing queue id or lease token', {
        workerId: this.workerId,
        claimRequestId,
        queueId: item?.id ?? null,
      });
      return;
    }

    const startedAt = Date.now();
    this.activeLease = {
      id: item.id,
      token: item.lease_token,
      healthy: true,
      expiresAt: this.#parseLeaseExpiry(item.leased_until),
    };
    this.#startLeaseRenewal(item, claimRequestId);

    let dispatchResult;
    try {
      dispatchResult = await this.dispatcher.dispatch(item, {
        canContinue: () => Boolean(this.activeLease?.healthy),
        workerId: this.workerId,
        claimRequestId,
      });
    } catch (error) {
      this.logger.error('Queue dispatcher threw unexpectedly', {
        workerId: this.workerId,
        claimRequestId,
        queueId: item.id,
        action: item.action ?? null,
        errorCode: error?.code ?? null,
      });
      dispatchResult = { success: false, reason: 'dispatcher_error' };
    }

    if (!this.activeLease?.healthy) {
      dispatchResult = { success: false, reason: 'lease_lost' };
    }

    const status = dispatchResult?.success ? 'complete' : 'failed';
    const acknowledged = await this.#acknowledge(item, status, dispatchResult);
    this.#stopLeaseRenewal();

    this.logger.info('Finished leased queue item', {
      workerId: this.workerId,
      claimRequestId,
      queueId: item.id,
      action: item.action ?? null,
      attempt: item.attempts ?? null,
      leaseExpiresAt: new Date(this.activeLease?.expiresAt ?? Date.now()).toISOString(),
      durationMs: Date.now() - startedAt,
      outcome: status,
      acknowledged,
    });
    this.activeLease = null;
  }

  async #acknowledge(item, status, dispatchResult) {
    let attempt = 0;

    while (this.#hasAcknowledgementTime()) {
      attempt += 1;
      try {
        const errorDetails = status === 'failed'
          ? {
              error_code: dispatchResult?.reason ?? undefined,
              error_message: dispatchResult?.message ?? undefined,
            }
          : {};
        await this.apiService.updateDiscordQueueStatus(item.id, status, item.lease_token, errorDetails);
        return true;
      } catch (error) {
        if (error?.response?.status === 409) {
          this.logger.warn('Queue acknowledgement rejected due to an invalid or expired lease', {
            workerId: this.workerId,
            queueId: item.id,
            status,
          });
          return false;
        }

        const delay = Math.min(
          this.acknowledgementBackoffMs * 2 ** (attempt - 1),
          10_000,
          Math.max((this.activeLease?.expiresAt ?? Date.now()) - Date.now() - this.leaseSafetyMs, 0),
        );
        if (delay <= 0) {
          break;
        }

        this.logger.warn('Retrying queue acknowledgement', {
          workerId: this.workerId,
          queueId: item.id,
          status,
          attempt,
          delayMs: delay,
          httpStatus: error?.response?.status ?? null,
          errorCode: error?.code ?? null,
        });
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    this.logger.error('Unable to acknowledge queue item before lease expiry', {
      workerId: this.workerId,
      queueId: item.id,
      status,
    });
    return false;
  }

  #startLeaseRenewal(item, claimRequestId) {
    this.#stopLeaseRenewal();
    this.leaseTimer = setInterval(async () => {
      if (!this.activeLease || this.leaseRenewing) {
        return;
      }

      this.leaseRenewing = true;
      try {
        const response = await this.apiService.renewDiscordQueueLease(item.id, item.lease_token);
        const renewedUntil = response?.data?.leased_until ?? response?.leased_until;
        this.activeLease.expiresAt = this.#parseLeaseExpiry(renewedUntil);
        this.logger.debug('Renewed queue lease', {
          workerId: this.workerId,
          claimRequestId,
          queueId: item.id,
          leaseExpiresAt: new Date(this.activeLease.expiresAt).toISOString(),
        });
      } catch (error) {
        this.activeLease.healthy = false;
        this.logger.error('Queue lease renewal failed; no further workflow steps will start', {
          workerId: this.workerId,
          claimRequestId,
          queueId: item.id,
          status: error?.response?.status ?? null,
          errorCode: error?.code ?? null,
        });
        this.#stopLeaseRenewal();
      } finally {
        this.leaseRenewing = false;
      }
    }, this.leaseRenewIntervalMs);
    this.leaseTimer.unref?.();
  }

  #stopLeaseRenewal() {
    if (this.leaseTimer) {
      clearInterval(this.leaseTimer);
      this.leaseTimer = null;
    }
  }

  #parseLeaseExpiry(value) {
    const parsed = Date.parse(value ?? '');
    return Number.isNaN(parsed) ? Date.now() + DEFAULT_LEASE_MS : parsed;
  }

  #hasAcknowledgementTime() {
    return Date.now() < (this.activeLease?.expiresAt ?? 0) - this.leaseSafetyMs;
  }

  #scheduleNextPoll(delay = this.currentPollIntervalMs) {
    if (this.stopped || this.pollTimer) {
      return;
    }

    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      const pollPromise = this.#poll();
      this.pollPromise = pollPromise;
      const clearPoll = () => {
        if (this.pollPromise === pollPromise) {
          this.pollPromise = null;
        }
      };
      void pollPromise.then(clearPoll, clearPoll);
    }, Math.max(0, delay));
    this.pollTimer.unref?.();
  }

  #increaseBackoff() {
    this.backoffAttempts += 1;
    this.currentPollIntervalMs = Math.min(
      this.pollIntervalMs * 2 ** this.backoffAttempts,
      this.maxBackoffMs,
    );
  }

  #resetBackoff() {
    this.backoffAttempts = 0;
    this.currentPollIntervalMs = this.pollIntervalMs;
  }
}
