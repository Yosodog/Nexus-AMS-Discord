import { randomUUID } from 'node:crypto';
import { createQueueExecutionContext } from './runtime/RuntimeContext.js';
import { FairScheduler } from './FairScheduler.js';

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
    lane = 'side_effects',
    enabled = true,
    connectionResolver = null,
    scheduler = null,
    apiServiceFactory = null,
    dispatcherFactory = null,
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
    const normalizedLane = typeof lane === 'string' ? lane.trim() : '';
    if (!normalizedLane) {
      throw new TypeError('Queue workers require an explicit queue lane.');
    }
    this.lane = normalizedLane;
    this.enabled = enabled;
    this.connectionResolver = connectionResolver;
    this.scheduler = scheduler ?? (connectionResolver ? new FairScheduler() : null);
    this.apiServiceFactory = apiServiceFactory;
    this.dispatcherFactory = dispatcherFactory;

    this.pollTimer = null;
    this.polling = false;
    this.pollPromise = null;
    this.backoffAttempts = 0;
    this.started = false;
    this.stopped = false;
    this.currentWork = null;
    this.activeLease = null;
    this.leaseTimer = null;
    this.leaseRenewalPromise = null;
    this.activeApiService = this.apiService;
    this.activeConnection = null;
  }

  start() {
    if (this.started || this.stopped || !this.enabled) {
      if (!this.enabled && !this.started) {
        this.started = true;
        this.logger.info('Queue worker disabled', { workerId: this.workerId, lane: this.lane });
      }
      return;
    }

    this.started = true;
    this.logger.info('Starting leased Nexus queue worker', { workerId: this.workerId, lane: this.lane });
    this.#scheduleNextPoll(0);
  }

  getHealthSnapshot() {
    return {
      started: this.started,
      stopped: this.stopped,
      polling: this.polling,
      active_item: Boolean(this.currentWork),
      lease_healthy: this.activeLease ? Boolean(this.activeLease.healthy) : null,
      backoff_attempts: this.backoffAttempts,
    };
  }

  /** Stop new claims and drain only while the current lease remains safe to use. */
  async stop({ timeoutMs } = {}) {
    if (this.stopped) {
      return { drained: !(this.currentWork ?? this.pollPromise) };
    }

    this.stopped = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.#stopLeaseRenewal();

    const drainingWork = this.currentWork ?? this.pollPromise;
    if (!drainingWork) {
      this.logger.info('Queue worker stopped', { workerId: this.workerId, drained: true });
      return { drained: true };
    }

    const drainTimeoutMs = timeoutMs ?? this.#shutdownDrainTimeoutMs();
    let timeout;
    const drained = await Promise.race([
      drainingWork.then(() => true, () => true),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve(false), Math.max(0, drainTimeoutMs));
      }),
    ]);
    clearTimeout(timeout);

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
      const claim = await this.#claim(requestId);
      const response = claim.response;
      const item = response?.data?.item ?? response?.data ?? response?.item ?? null;
      this.#resetBackoff();

      if (!item) {
        this.logger.debug('No leased Discord command available', {
          workerId: this.workerId,
          lane: this.lane,
          claimRequestId: requestId,
        });
      } else {
        this.currentWork = this.#processItem(item, requestId, claim);
        await this.currentWork;
        nextDelay = 0;
      }
    } catch (error) {
      this.#increaseBackoff();
      nextDelay = this.currentPollIntervalMs;
      this.logger.warn('Failed to claim Nexus Discord queue item', {
        workerId: this.workerId,
        lane: this.lane,
        status: error?.response?.status ?? null,
        errorCode: error?.code ?? null,
      });
    } finally {
      this.currentWork = null;
      this.polling = false;
      this.#scheduleNextPoll(nextDelay);
    }
  }

  async #claim(requestId) {
    if (!this.connectionResolver) {
      return {
        response: await this.apiService.claimDiscordQueue(
          this.workerId,
          requestId,
          this.lane,
          this.apiService?.relaySigner?.guildId ?? null,
          this.apiService?.connectionContext ?? null,
        ),
        apiService: this.apiService,
        connection: null,
      };
    }

    const connections = this.connectionResolver.listActive();
    for (const connection of connections) this.scheduler.register(connection.connectionId);
    const activeIds = connections.map((connection) => connection.connectionId);
    const activeSet = new Set(activeIds);
    for (const entry of this.scheduler.snapshot?.() ?? []) {
      if (!activeSet.has(entry.connection_id)) this.scheduler.unregister(entry.connection_id);
    }
    const selectedId = this.scheduler.next(activeIds);
    if (!selectedId) return { response: { data: null }, apiService: this.apiService, connection: null };
    const connection = connections.find((candidate) => candidate.connectionId === selectedId);
    const apiService = this.apiServiceFactory?.(connection) ?? connection.apiService ?? this.apiService;
    if (!apiService?.claimDiscordQueue) {
      throw new Error('No API service is configured for the resolved connection.');
    }
    return {
      response: await apiService.claimDiscordQueue(
        this.workerId,
        requestId,
        this.lane,
        connection.guildId,
        connection,
      ),
      apiService,
      connection,
    };
  }

  async #processItem(item, claimRequestId, claim = {}) {
    if (!item?.id || !item?.lease_token) {
      this.logger.error('Claim response missing queue id or lease token', {
        workerId: this.workerId,
        claimRequestId,
        queueId: item?.id ?? null,
      });
      return;
    }

    const startedAt = Date.now();
    let connection = claim.connection;
    if (this.connectionResolver) {
      try {
        connection = this.connectionResolver.resolveDelivery(item);
      } catch (error) {
        this.logger.error('Refusing queue item with an invalid connection binding', {
          workerId: this.workerId,
          claimRequestId,
          queueId: item.id,
          errorCode: error?.code ?? 'INVALID_CONNECTION_BINDING',
        });
        return;
      }
    }
    const apiService = claim.apiService ?? this.apiService;
    const dispatcher = this.dispatcherFactory?.(connection) ?? this.dispatcher;
    this.activeApiService = apiService;
    this.activeConnection = connection;
    this.activeLease = {
      id: item.id,
      token: item.lease_token,
      healthy: true,
      renewable: false,
      expiresAt: this.#parseLeaseExpiry(item.leased_until),
    };
    this.#startLeaseRenewal(item, claimRequestId);

    let dispatchResult;
    try {
      const execution = connection
        ? createQueueExecutionContext({
            connection,
            item,
            workerId: this.workerId,
            claimRequestId,
            canContinue: () => Boolean(this.activeLease?.healthy)
              && this.#hasAcknowledgementTime()
              && this.#connectionIsCurrent(connection),
          })
        : {
            canContinue: () => Boolean(this.activeLease?.healthy) && this.#hasAcknowledgementTime(),
            workerId: this.workerId,
            claimRequestId,
          };
      dispatchResult = await dispatcher.dispatch(item, execution);
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

    if (connection && !this.#connectionIsCurrent(connection)) {
      dispatchResult = { success: false, reason: 'connection_revoked' };
    } else if (!this.activeLease?.healthy) {
      dispatchResult = { success: false, reason: 'lease_lost' };
    }

    const status = dispatchResult?.success ? 'complete' : 'failed';
    const acknowledged = await this.#acknowledge(item, status, dispatchResult, apiService);
    this.#stopLeaseRenewal();

    this.logger.info('Finished leased queue item', {
      workerId: this.workerId,
      lane: this.lane,
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
    this.activeConnection = null;
    this.activeApiService = this.apiService;
  }

  async #acknowledge(item, status, dispatchResult, apiService = this.activeApiService) {
    let attempt = 0;

    while (this.#hasAcknowledgementTime()) {
      attempt += 1;
      try {
        const outcomeDetails = {};
        if (dispatchResult?.result !== undefined) outcomeDetails.result = dispatchResult.result;
        if (status === 'failed') {
          outcomeDetails.error_code = dispatchResult?.reason ?? undefined;
          outcomeDetails.error_message = dispatchResult?.message ?? undefined;
        }
        await apiService.updateDiscordQueueStatus(item.id, status, item.lease_token, outcomeDetails);
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

    if (this.stopped) {
      return;
    }

    this.activeLease.renewable = true;
    this.leaseTimer = setInterval(() => {
      if (!this.activeLease || this.leaseRenewalPromise) {
        return;
      }

      const activeLease = this.activeLease;
      const renewalPromise = this.#renewLease(item, claimRequestId, activeLease);
      this.leaseRenewalPromise = renewalPromise;
      const clearRenewalPromise = () => {
        if (this.leaseRenewalPromise === renewalPromise) {
          this.leaseRenewalPromise = null;
        }
      };
      void renewalPromise.then(clearRenewalPromise, clearRenewalPromise);
    }, this.leaseRenewIntervalMs);
    this.leaseTimer.unref?.();
  }

  async #renewLease(item, claimRequestId, activeLease) {
    if (this.activeConnection && !this.#connectionIsCurrent(this.activeConnection)) {
      activeLease.healthy = false;
      this.logger.error('Queue connection was revoked; no further workflow steps will start', {
        workerId: this.workerId,
        claimRequestId,
        queueId: item.id,
        errorCode: 'CONNECTION_REVOKED',
      });
      this.#stopLeaseRenewal();
      return;
    }

    try {
      const response = await this.activeApiService.renewDiscordQueueLease(item.id, item.lease_token);
      if (this.activeLease !== activeLease || !activeLease.renewable) {
        return;
      }

      const renewedUntil = response?.data?.leased_until ?? response?.leased_until;
      activeLease.expiresAt = this.#parseLeaseExpiry(renewedUntil);
      this.logger.debug('Renewed queue lease', {
        workerId: this.workerId,
        claimRequestId,
        queueId: item.id,
        leaseExpiresAt: new Date(activeLease.expiresAt).toISOString(),
      });
    } catch (error) {
      if (this.activeLease !== activeLease || !activeLease.renewable) {
        return;
      }

      activeLease.healthy = false;
      this.logger.error('Queue lease renewal failed; no further workflow steps will start', {
        workerId: this.workerId,
        claimRequestId,
        queueId: item.id,
        status: error?.response?.status ?? null,
        errorCode: error?.code ?? null,
      });
      this.#stopLeaseRenewal();
    }
  }

  #stopLeaseRenewal() {
    if (this.activeLease) {
      this.activeLease.renewable = false;
    }

    if (this.leaseTimer) {
      clearInterval(this.leaseTimer);
      this.leaseTimer = null;
    }
    this.leaseRenewalPromise = null;
  }

  #parseLeaseExpiry(value) {
    const parsed = Date.parse(value ?? '');
    return Number.isNaN(parsed) ? Date.now() + DEFAULT_LEASE_MS : parsed;
  }

  #hasAcknowledgementTime() {
    return Date.now() < (this.activeLease?.expiresAt ?? 0) - this.leaseSafetyMs;
  }

  #connectionIsCurrent(connection) {
    if (!this.connectionResolver || !connection) return true;
    try {
      const current = this.connectionResolver.resolve({
        applicationId: connection.applicationId,
        guildId: connection.guildId,
      });
      return current.connectionId === connection.connectionId
        && current.generation === connection.generation;
    } catch {
      return false;
    }
  }

  #shutdownDrainTimeoutMs() {
    const now = Date.now();
    const leaseExpiresAt = Number.isFinite(this.activeLease?.expiresAt)
      ? this.activeLease.expiresAt
      : now + DEFAULT_LEASE_MS;

    return Math.max(
      0,
      Math.min(leaseExpiresAt - now, DEFAULT_LEASE_MS) - this.leaseSafetyMs,
    );
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
