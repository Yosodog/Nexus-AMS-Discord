const DEFAULT_INITIAL_RETRY_MS = 15_000;
const DEFAULT_MAX_RETRY_MS = 5 * 60 * 1000;

const extractCapabilities = (response) => response?.capabilities
  ?? response?.data?.capabilities
  ?? response?.manifest?.capabilities
  ?? response?.data?.manifest?.capabilities
  ?? {};

const positiveIntegerOr = (value, fallback) => (
  Number.isSafeInteger(value) && value > 0 ? value : fallback
);

/**
 * Verifies the Nexus alert renderer manifest and keeps retrying with capped
 * exponential backoff until it verifies. A transient Nexus outage at boot
 * (for example the bot starting before PHP is serving) must not leave the
 * alert and digest lanes disabled until the next process restart.
 */
export class AlertManifestMonitor {
  constructor({
    apiService,
    registry,
    logger,
    onReady = () => undefined,
    initialRetryMs = DEFAULT_INITIAL_RETRY_MS,
    maxRetryMs = DEFAULT_MAX_RETRY_MS,
    schedule = setTimeout,
    cancel = clearTimeout,
  } = {}) {
    if (typeof apiService?.getAlertRendererManifest !== 'function') {
      throw new TypeError('Alert manifest monitor requires an API service.');
    }
    if (typeof registry?.verifyManifest !== 'function') {
      throw new TypeError('Alert manifest monitor requires a renderer registry.');
    }

    this.apiService = apiService;
    this.registry = registry;
    this.logger = logger;
    this.onReady = onReady;
    this.initialRetryMs = positiveIntegerOr(initialRetryMs, DEFAULT_INITIAL_RETRY_MS);
    this.maxRetryMs = Math.max(this.initialRetryMs, positiveIntegerOr(maxRetryMs, DEFAULT_MAX_RETRY_MS));
    this.schedule = schedule;
    this.cancel = cancel;

    this.status = { valid: false, reason: 'alert_manifest_unverified' };
    this.capabilities = {};
    this.ready = false;
    this.failureCount = 0;
    this.timer = null;
    this.checkPromise = null;
    this.stopped = false;
  }

  get lanesEnabled() {
    return this.status.valid && this.capabilities.queue_lanes === true;
  }

  /**
   * Performs the first verification. On failure a background retry is
   * scheduled and `onReady` fires once a later attempt succeeds.
   */
  async start() {
    await this.check();
    return this.lanesEnabled;
  }

  check() {
    if (this.checkPromise) return this.checkPromise;
    if (this.stopped || this.ready) return Promise.resolve(this.lanesEnabled);

    const operation = this.#check().finally(() => {
      if (this.checkPromise === operation) this.checkPromise = null;
    });
    this.checkPromise = operation;
    return operation;
  }

  async stop() {
    this.stopped = true;
    if (this.timer) {
      this.cancel(this.timer);
      this.timer = null;
    }
    await this.checkPromise?.catch(() => undefined);
  }

  getHealthSnapshot() {
    return {
      verified: this.status.valid,
      lanes_enabled: this.lanesEnabled,
      failure_count: this.failureCount,
      retry_scheduled: this.timer !== null,
    };
  }

  async #check() {
    try {
      const response = await this.apiService.getAlertRendererManifest();
      this.status = this.registry.verifyManifest(response);
      this.capabilities = extractCapabilities(response);
      if (!this.status.valid) {
        this.#recordFailure('Alert lane disabled because the renderer manifest did not verify', this.status);
      }
    } catch (error) {
      this.status = { valid: false, reason: 'alert_manifest_unavailable' };
      this.capabilities = {};
      this.#recordFailure('Alert lane disabled because the renderer manifest could not be fetched', {
        status: error?.response?.status ?? null,
        errorCode: error?.code ?? null,
      });
    }

    if (this.status.valid && !this.lanesEnabled) {
      this.#recordFailure('Alert lane disabled because the renderer manifest does not advertise queue lanes', {
        contractVersion: this.status.contract_version,
      });
    }

    if (this.lanesEnabled) {
      await this.#markReady();
    } else {
      this.#scheduleRetry();
    }

    return this.lanesEnabled;
  }

  async #markReady() {
    const recovered = this.failureCount > 0;
    this.ready = true;
    this.logger?.info?.(recovered ? 'Alert renderer manifest verified after retry' : 'Alert renderer manifest verified', {
      contractVersion: this.status.contract_version,
      ...(recovered ? { failedAttempts: this.failureCount } : {}),
    });

    try {
      await this.onReady({ status: this.status, capabilities: this.capabilities, recovered });
    } catch {
      this.logger?.error?.('Failed to enable alert lanes after manifest verification', {
        errorCode: 'ALERT_LANE_ENABLE_FAILED',
      });
    }
  }

  #recordFailure(message, context) {
    this.failureCount += 1;
    const retryInMs = this.#nextDelayMs();
    this.logger?.error?.(message, { ...context, attempt: this.failureCount, retryInMs });
  }

  #nextDelayMs() {
    const exponent = Math.max(0, this.failureCount - 1);
    return Math.min(this.maxRetryMs, this.initialRetryMs * (2 ** Math.min(exponent, 20)));
  }

  #scheduleRetry() {
    if (this.stopped) return;
    if (this.timer) this.cancel(this.timer);
    this.timer = this.schedule(() => {
      this.timer = null;
      void this.check();
    }, this.#nextDelayMs());
    this.timer?.unref?.();
  }
}
