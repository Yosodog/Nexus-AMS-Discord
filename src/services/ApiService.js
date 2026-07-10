import axios from 'axios';

export const RetryMode = Object.freeze({
  SAFE: 'safe',
  IDEMPOTENT: 'idempotent',
  NEVER: 'never',
});

/**
 * REST API client wrapper for Nexus AMS backend.
 * Only scaffolds shared concerns (base configuration, retries, headers) for future expansion.
 */
export class ApiService {
  /**
   * @param {object} options configuration options
   * @param {string} options.baseUrl base URL for the Nexus API
   * @param {string} options.apiKey shared secret for authentication
   * @param {import('./Logger.js').Logger} options.logger structured logger instance
   * @param {number} [options.timeoutMs=10000] request timeout in milliseconds
   * @param {number} [options.maxRetries=3] number of retry attempts for transient failures
   */
  constructor({
    baseUrl,
    apiKey,
    logger,
    timeoutMs = 10000,
    maxRetries = 3,
    random = Math.random,
    sleep = null,
  }) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.logger = logger;
    this.maxRetries = maxRetries;
    this.random = random;
    this.sleep = sleep ?? ((durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)));

    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Nexus-AMS-DiscordBot/0.1',
        'X-API-Key': this.apiKey,
        // Some Nexus endpoints expect bearer tokens; keep both headers for flexibility.
        Authorization: `Bearer ${this.apiKey}`,
      },
    });
  }

  /**
   * Generic request wrapper with basic retry support for transient network/server issues.
   * @param {object} options axios-compatible request options
   * @returns {Promise<any>} parsed JSON response body
   */
  async request(options, retryMode = RetryMode.NEVER) {
    if (!Object.values(RetryMode).includes(retryMode)) {
      throw new TypeError(`Unknown API retry mode: ${retryMode}`);
    }

    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await this.http.request(options);
        return response.data;
      } catch (error) {
        const isLastAttempt = attempt === this.maxRetries;
        const retryable = retryMode !== RetryMode.NEVER && this.#isRetryableError(error);
        this.logger.warn(
          `API request failed (attempt ${attempt}/${this.maxRetries})`,
          {
            url: options?.url,
            method: options?.method,
            status: error?.response?.status ?? null,
            retryMode,
            retryable,
            errorCode: error?.code ?? null,
          },
        );

        if (isLastAttempt || !retryable) {
          this.logger.error('API request failed permanently', {
            url: options?.url,
            method: options?.method,
            status: error?.response?.status ?? null,
            retryMode,
            errorCode: error?.code ?? null,
          });
          throw error;
        }

        await this.#delay(this.#retryDelay(error, attempt));
      }
    }

    // This should never be hit, but return undefined to satisfy explicit control flow.
    return undefined;
  }

  /**
   * Fetch pending Discord commands from the Nexus queue API.
   * @param {number} [limit=20] maximum number of items to fetch per poll
   * @returns {Promise<{ data: any[] }>} response payload from Nexus
   */
  async fetchDiscordQueue(limit = 20) {
    const endpointUrl = new URL('/api/v1/discord/queue', this.baseUrl);
    endpointUrl.searchParams.set('limit', String(limit));

    return this.request({
      method: 'get',
      url: endpointUrl.toString(),
    }, RetryMode.SAFE);
  }

  /** Claim one queue item with an idempotent request identifier. */
  async claimDiscordQueue(workerId, requestId) {
    const endpointUrl = new URL('/api/v1/discord/queue/claim', this.baseUrl).toString();

    return this.request({
      method: 'post',
      url: endpointUrl,
      data: { worker_id: workerId, request_id: requestId },
    }, RetryMode.IDEMPOTENT);
  }

  /** Renew an active queue lease. */
  async renewDiscordQueueLease(id, leaseToken) {
    const endpointUrl = new URL(`/api/v1/discord/queue/${id}/lease`, this.baseUrl).toString();

    return this.request({
      method: 'post',
      url: endpointUrl,
      data: { lease_token: leaseToken },
    }, RetryMode.IDEMPOTENT);
  }

  /** Persist an action-specific durable checkpoint. */
  async checkpointDiscordQueue(id, leaseToken, result) {
    const endpointUrl = new URL(`/api/v1/discord/queue/${id}/checkpoint`, this.baseUrl).toString();

    return this.request({
      method: 'patch',
      url: endpointUrl,
      data: { lease_token: leaseToken, result },
    }, RetryMode.IDEMPOTENT);
  }

  /**
   * Report the processing outcome for a queued Discord command.
   * @param {string} id queue item identifier
   * @param {'complete' | 'failed'} status processing status to report
   * @returns {Promise<any>} response payload
   */
  async updateDiscordQueueStatus(id, status, leaseToken = null, errorDetails = {}) {
    const endpointUrl = new URL(`/api/v1/discord/queue/${id}/status`, this.baseUrl);

    const data = { status };
    if (leaseToken) {
      data.lease_token = leaseToken;
    }
    if (status === 'failed' && errorDetails?.error_code) {
      data.error_code = errorDetails.error_code;
    }
    if (status === 'failed' && errorDetails?.error_message) {
      data.error_message = errorDetails.error_message;
    }

    return this.request({
      method: 'post',
      url: endpointUrl.toString(),
      data,
    }, leaseToken ? RetryMode.IDEMPOTENT : RetryMode.NEVER);
  }

  /** Fetch the current persisted war-counter record. */
  async getWarCounter(id) {
    const endpointUrl = new URL(`/api/v1/discord/war-counters/${id}`, this.baseUrl).toString();
    return this.request({ method: 'get', url: endpointUrl }, RetryMode.SAFE);
  }

  /**
   * Submit a new application on behalf of a Discord user.
   * @param {{ nation_id: number, discord_user_id: string, discord_username: string }} payload application payload
   * @returns {Promise<any>} Nexus response containing application and config
   */
  async createApplication(payload) {
    const endpointUrl = new URL('/api/v1/discord/applications', this.baseUrl).toString();

    return this.request({
      method: 'post',
      url: endpointUrl,
      data: payload,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    }, RetryMode.NEVER);
  }

  /**
   * Attach a Discord channel to an application for transcript correlation.
   * @param {{ application_id: number|string, discord_channel_id: string }} payload association payload
   * @returns {Promise<any>} Nexus response
   */
  async attachApplicationChannel(payload) {
    const endpointUrl = new URL('/api/v1/discord/applications/attach-channel', this.baseUrl).toString();

    return this.request({
      method: 'post',
      url: endpointUrl,
      data: payload,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    }, RetryMode.IDEMPOTENT);
  }

  /**
   * Attach a Discord channel/thread to a war counter.
   * @param {{ war_counter_id: number|string, discord_channel_id: string }} payload association payload
   * @returns {Promise<any>} Nexus response
   */
  async attachWarCounterChannel(payload) {
    const endpointUrl = new URL('/api/v1/discord/war-counters/attach-channel', this.baseUrl).toString();

    return this.request({
      method: 'post',
      url: endpointUrl,
      data: payload,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    }, RetryMode.IDEMPOTENT);
  }

  /**
   * Archive a war counter in Nexus.
   * @param {{ war_counter_id: number|string, moderator_discord_id: string }} payload archive request payload
   * @returns {Promise<{ counter?: any, archived?: boolean, already_archived?: boolean }>} Nexus response
   */
  async archiveWarCounter(payload) {
    const endpointUrl = new URL('/api/v1/discord/war-counters/archive', this.baseUrl).toString();

    return this.request({
      method: 'post',
      url: endpointUrl,
      data: payload,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    }, RetryMode.IDEMPOTENT);
  }

  /**
   * Sweep the main bank into the primary enabled offshore.
   * @param {{ moderator_discord_id: string, note?: string }} payload sweep request payload
   * @returns {Promise<any>} Nexus response
   */
  async sweepPrimaryOffshore(payload) {
    const endpointUrl = new URL('/api/v1/discord/offshores/sweep-primary', this.baseUrl).toString();

    return this.request({
      method: 'post',
      url: endpointUrl,
      data: payload,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    }, RetryMode.IDEMPOTENT);
  }

  /**
   * Log a Discord message to Nexus for transcript storage.
   * @param {{ discord_channel_id: string, discord_message_id: string, discord_user_id: string, discord_username: string, content: string, sent_at: number }} payload message payload; Nexus derives staff status
   * @returns {Promise<any>} Nexus response indicating logging status
   */
  async logApplicationMessage(payload) {
    const endpointUrl = new URL('/api/v1/discord/applications/messages', this.baseUrl).toString();

    return this.request({
      method: 'post',
      url: endpointUrl,
      data: payload,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    }, RetryMode.IDEMPOTENT);
  }

  /**
   * Submit an intel report captured from Discord to Nexus.
   * @param {{ report: string, source?: string }} payload intel payload containing the raw in-game text
   * @returns {Promise<any>} Nexus response with parsed intel details
   */
  async sendIntelReport(payload) {
    const endpointUrl = new URL('/api/v1/discord/intel', this.baseUrl).toString();

    return this.request({
      method: 'post',
      url: endpointUrl,
      data: payload,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    }, RetryMode.IDEMPOTENT);
  }

  /**
   * Approve an applicant via Nexus.
   * @param {{ applicant_discord_id: string, moderator_discord_id: string, approval_request_id?: string }} payload approval payload
   * @returns {Promise<any>} Nexus response containing config for post-approval actions
   */
  async approveApplication(payload) {
    const endpointUrl = new URL('/api/v1/discord/applications/approve', this.baseUrl).toString();

    return this.request({
      method: 'post',
      url: endpointUrl,
      data: payload,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    }, RetryMode.IDEMPOTENT);
  }

  /**
   * Deny an applicant via Nexus.
   * @param {{ applicant_discord_id: string, moderator_discord_id: string, denial_request_id?: string }} payload denial payload
   * @returns {Promise<any>} Nexus response
   */
  async denyApplication(payload) {
    const endpointUrl = new URL('/api/v1/discord/applications/deny', this.baseUrl).toString();

    return this.request({
      method: 'post',
      url: endpointUrl,
      data: payload,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    }, RetryMode.IDEMPOTENT);
  }

  /**
   * Exchange a Discord-issued verification code with Nexus to link user accounts.
   * Always returns a normalized outcome instead of throwing so callers can render friendly errors.
   * @param {object} payload verification payload to send to Nexus
   * @param {string} payload.token verification code provided by the user
   * @param {string} payload.discord_id Discord user snowflake ID
   * @param {string} payload.discord_username Discord username (non-unique)
   * @param {string} [payload.discord_global_name] Discord global display name, if available
   * @param {string} [payload.discord_discriminator] Legacy discriminator/tag when present
   * @param {string} [payload.discord_avatar] Fully-qualified avatar URL for auditing
   * @param {object} [payload.metadata] Optional metadata for troubleshooting/auditing
   * @returns {Promise<{ success: boolean, data?: any, error?: { status: number | null, code: string, message: string, details?: any } }>}
   */
  async verifyUser(payload) {
    const endpointUrl = new URL('/api/v1/discord/verify', this.baseUrl).toString();

    // Mask secrets before logging to avoid leaking user-provided codes.
    const maskedPayload = {
      ...payload,
      token: '[REDACTED]',
    };

    this.logger.info('Sending verification request to Nexus', {
      url: endpointUrl,
      discordId: maskedPayload.discord_id ?? null,
    });

    try {
      const response = await this.http.post(endpointUrl, payload, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });

      this.logger.info('Verification request succeeded', {
        status: response.status,
        endpoint: endpointUrl,
      });

      return { success: true, data: response.data };
    } catch (error) {
      // Axios error classification: response (API returned an error), request (no response), or config.
      if (error.response) {
        const { status, data } = error.response;

        const errorCode = this.#mapStatusToErrorCode(status, data);
        const message = this.#deriveErrorMessage(status, data);
        const details = this.#sanitizeErrorData(data);

        const normalized = {
          success: false,
          status,
          code: errorCode,
          message,
          details,
          error: {
            status,
            code: errorCode,
            message,
            details,
          },
        };

        this.logger.warn('Verification request failed with API response', {
          status,
          endpoint: endpointUrl,
          code: errorCode,
        });

        return normalized;
      }

      if (error.request) {
        // Request was sent but no response received.
        this.logger.error('Verification request reached Nexus but no response was received', error.message ?? error);
        return {
          success: false,
          status: null,
          code: 'NETWORK_ERROR',
          message: 'Unable to reach Nexus right now. Please try again shortly.',
          error: {
            status: null,
            code: 'NETWORK_ERROR',
            message: 'Unable to reach Nexus right now. Please try again shortly.',
          },
        };
      }

      // Something went wrong constructing the request before it could be sent.
      this.logger.error('Unexpected verification failure before request was sent', error);
      return {
        success: false,
        status: null,
        code: 'UNEXPECTED_ERROR',
        message: 'An unexpected error occurred while preparing your verification.',
        error: {
          status: null,
          code: 'UNEXPECTED_ERROR',
          message: 'An unexpected error occurred while preparing your verification.',
        },
      };
    }
  }

  async #delay(durationMs) {
    await this.sleep(durationMs);
  }

  #isRetryableError(error) {
    if (!error) {
      return false;
    }

    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      return true;
    }

    if (!error.response) {
      return true;
    }

    const status = error.response.status;
    return status === 408 || status === 429 || status >= 500;
  }

  #retryDelay(error, attempt) {
    const headers = error?.response?.headers;
    const retryAfterHeader = headers?.get?.('retry-after') ?? headers?.['retry-after'];
    const retryAfter = this.#parseRetryAfter(retryAfterHeader);
    if (retryAfter !== null) {
      return retryAfter;
    }

    const base = 500;
    const exponential = base * 2 ** (attempt - 1);
    const jitter = Math.floor(this.random() * Math.min(exponential * 0.25, 1000));
    return exponential + jitter;
  }

  #parseRetryAfter(value) {
    if (value === undefined || value === null || value === '') {
      return null;
    }

    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(Math.ceil(seconds * 1000), 5 * 60 * 1000);
    }

    const date = Date.parse(String(value));
    if (Number.isNaN(date)) {
      return null;
    }

    return Math.min(Math.max(date - Date.now(), 0), 5 * 60 * 1000);
  }

  #mapStatusToErrorCode(status, data) {
    if (status === 400) {
      return 'VALIDATION_ERROR';
    }

    if (status === 401 || status === 403) {
      return 'AUTHENTICATION_FAILED';
    }

    if (status === 404) {
      return 'NOT_FOUND';
    }

    if (status === 409) {
      return 'CONFLICT';
    }

    if (status >= 500) {
      return 'SERVER_ERROR';
    }

    // Fall back to any server-provided error code to aid troubleshooting.
    if (typeof data?.code === 'string' && data.code.trim() !== '') {
      return data.code;
    }

    return 'API_ERROR';
  }

  #deriveErrorMessage(status, data) {
    if (typeof data?.message === 'string' && data.message.trim() !== '') {
      return data.message;
    }

    if (status === 400) {
      return 'The verification code appears invalid or has expired.';
    }

    if (status === 401 || status === 403) {
      return 'Authentication with Nexus failed. Please contact an administrator.';
    }

    if (status === 404) {
      return 'No verification request was found for that code.';
    }

    if (status === 409) {
      return 'This verification request was already used or the account is already linked.';
    }

    if (status >= 500) {
      return 'Nexus is unavailable right now. Please try again later.';
    }

    return 'An unexpected error occurred while verifying your account.';
  }

  #sanitizeErrorData(data) {
    if (!data || typeof data !== 'object') {
      return data;
    }

    const clone = { ...data };

    if (clone.token) {
      clone.token = '[REDACTED]';
    }

    return clone;
  }
}
