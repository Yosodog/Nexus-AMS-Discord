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
   * Placeholder for future Nexus-specific methods.
   * Intentionally unimplemented for Phase 1.
   */
  async verifyUser() {
    throw new Error('verifyUser is not implemented in Phase 1.');
  }

  async #delay(durationMs) {
    await new Promise((resolve) => setTimeout(resolve, durationMs));
  }

  #backoffDuration(attempt) {
    // Exponential backoff with a modest base to keep retries responsive during development.
    const base = 500;
    return base * 2 ** (attempt - 1);
  }
}
