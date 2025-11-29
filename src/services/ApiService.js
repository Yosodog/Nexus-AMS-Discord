import axios from 'axios';

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
  constructor({ baseUrl, apiKey, logger, timeoutMs = 10000, maxRetries = 3 }) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.logger = logger;
    this.maxRetries = maxRetries;

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
  async request(options) {
    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await this.http.request(options);
        return response.data;
      } catch (error) {
        const isLastAttempt = attempt === this.maxRetries;
        this.logger.warn(
          `API request failed (attempt ${attempt}/${this.maxRetries})`,
          error?.message ?? error,
        );

        if (isLastAttempt) {
          this.logger.error('Exhausted retries for API request', options?.url);
          throw error;
        }

        await this.#delay(this.#backoffDuration(attempt));
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
    });
  }

  /**
   * Report the processing outcome for a queued Discord command.
   * @param {string} id queue item identifier
   * @param {'complete' | 'failed'} status processing status to report
   * @returns {Promise<any>} response payload
   */
  async updateDiscordQueueStatus(id, status) {
    const endpointUrl = new URL(`/api/v1/discord/queue/${id}/status`, this.baseUrl);

    return this.request({
      method: 'post',
      url: endpointUrl.toString(),
      data: { status },
    });
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

    this.logger.info('Sending verification request to Nexus', { url: endpointUrl, payload: maskedPayload });

    try {
      const response = await this.http.post(endpointUrl, payload, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });

      this.logger.info('Verification request succeeded', {
        status: response.status,
        endpoint: endpointUrl,
        response: this.#sanitizeErrorData(response.data),
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
          error: normalized,
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
    await new Promise((resolve) => setTimeout(resolve, durationMs));
  }

  #backoffDuration(attempt) {
    // Exponential backoff with a modest base to keep retries responsive during development.
    const base = 500;
    return base * 2 ** (attempt - 1);
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
