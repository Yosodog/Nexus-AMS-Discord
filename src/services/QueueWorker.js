/**
 * Polls the Nexus Discord queue and dispatches commands for processing.
 * Applies a conservative exponential backoff on network failures to avoid hammering Nexus.
 */
export class QueueWorker {
  constructor({
    apiService,
    dispatcher,
    logger,
    pollIntervalMs = 30000,
    maxBackoffMs = 5 * 60 * 1000,
    statusBackoffBaseMs = 10000,
  }) {
    this.apiService = apiService;
    this.dispatcher = dispatcher;
    this.logger = logger;

    this.pollIntervalMs = pollIntervalMs;
    this.currentPollIntervalMs = pollIntervalMs;
    this.maxBackoffMs = maxBackoffMs;
    this.statusBackoffBaseMs = statusBackoffBaseMs;

    this.pollTimer = null;
    this.polling = false;
    this.backoffAttempts = 0;
    this.pendingStatusUpdates = new Map();
  }

  start() {
    if (this.pollTimer) {
      return;
    }

    this.logger.info(`Starting Nexus queue polling (every ${Math.round(this.pollIntervalMs / 1000)}s).`);
    this.#scheduleNextPoll(0);
  }

  stop() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
      this.logger.info('Queue polling stopped.');
    }
  }

  async #poll() {
    if (this.polling) {
      this.logger.debug('Skipping poll because a previous cycle is still running.');
      this.#scheduleNextPoll();
      return;
    }

    this.polling = true;

    try {
      await this.#flushPendingStatusUpdates();
      const { items, success } = await this.#fetchQueue();

      if (items.length === 0) {
        this.logger.debug('No queued Discord commands returned from Nexus.');
      }

      for (const item of items) {
        await this.#processItem(item);
      }

      if (success) {
        this.#resetBackoff();
      }
    } finally {
      this.polling = false;
      this.#scheduleNextPoll();
    }
  }

  async #fetchQueue() {
    const result = { items: [], success: true };

    try {
      const response = await this.apiService.fetchDiscordQueue(20);
      const queueItems = Array.isArray(response?.data) ? response.data : [];
      this.logger.debug(`Fetched ${queueItems.length} queue item(s) from Nexus.`);
      result.items = queueItems;
    } catch (error) {
      this.logger.warn('Failed to fetch Nexus Discord queue', error?.message ?? error);

      if (this.#isNetworkError(error)) {
        this.#increaseBackoff();
        result.success = false;
      }
    }

    return result;
  }

  async #processItem(item) {
    if (!item?.id) {
      this.logger.warn('Skipping queue item without an id', item);
      return;
    }

    const dispatchResult = await this.dispatcher.dispatch(item);
    const status = dispatchResult?.success ? 'complete' : 'failed';

    await this.#reportStatus(item.id, status);
  }

  async #reportStatus(id, status) {
    try {
      await this.apiService.updateDiscordQueueStatus(id, status);
      this.logger.debug(`Reported status "${status}" for queue item ${id}.`);
    } catch (error) {
      if (this.#isNetworkError(error)) {
        this.#enqueueStatusRetry(id, status);
        return;
      }

      this.logger.error(`Failed to send status update for ${id}`, error?.message ?? error);
    }
  }

  #enqueueStatusRetry(id, status) {
    const existingAttempt = this.pendingStatusUpdates.get(id)?.attempt ?? 0;
    const attempt = existingAttempt + 1;
    const delay = Math.min(this.statusBackoffBaseMs * 2 ** (attempt - 1), this.maxBackoffMs);

    this.pendingStatusUpdates.set(id, {
      id,
      status,
      attempt,
      nextAttemptAt: Date.now() + delay,
    });

    this.logger.warn(
      `Queued retry ${attempt} for status update of ${id} in ${Math.round(delay / 1000)}s due to network issue.`,
    );
  }

  async #flushPendingStatusUpdates() {
    if (this.pendingStatusUpdates.size === 0) {
      return;
    }

    const now = Date.now();
    const dueUpdates = Array.from(this.pendingStatusUpdates.values()).filter(
      (update) => update.nextAttemptAt <= now,
    );

    for (const update of dueUpdates) {
      try {
        await this.apiService.updateDiscordQueueStatus(update.id, update.status);
        this.pendingStatusUpdates.delete(update.id);
        this.logger.info(
          `Successfully retried status "${update.status}" for queue item ${update.id} (attempt ${update.attempt}).`,
        );
      } catch (error) {
        if (this.#isNetworkError(error)) {
          this.#enqueueStatusRetry(update.id, update.status);
          continue;
        }

        this.pendingStatusUpdates.delete(update.id);
        this.logger.error(
          `Dropping status retry for ${update.id} after non-retriable error`,
          error?.message ?? error,
        );
      }
    }
  }

  #scheduleNextPoll(delay = this.currentPollIntervalMs) {
    this.pollTimer = setTimeout(() => this.#poll(), delay);
  }

  #increaseBackoff() {
    this.backoffAttempts += 1;
    const backoffDelay = Math.min(this.pollIntervalMs * 2 ** this.backoffAttempts, this.maxBackoffMs);
    this.currentPollIntervalMs = backoffDelay;

    this.logger.warn(
      `Network issue contacting Nexus queue; increasing poll interval to ${Math.round(
        backoffDelay / 1000,
      )}s (attempt ${this.backoffAttempts}).`,
    );
  }

  #resetBackoff() {
    if (this.currentPollIntervalMs !== this.pollIntervalMs || this.backoffAttempts > 0) {
      this.logger.debug('Resetting queue poll backoff to base interval.');
    }

    this.backoffAttempts = 0;
    this.currentPollIntervalMs = this.pollIntervalMs;
  }

  #isNetworkError(error) {
    if (!error) {
      return false;
    }

    if (error.response) {
      return false;
    }

    return Boolean(error.code) || Boolean(error.request);
  }
}
