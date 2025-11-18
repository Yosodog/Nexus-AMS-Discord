import WebSocket from 'ws';

/**
 * WebSocket client stub for Reverb real-time notifications.
 * Establishes connection, handles reconnects, and sends heartbeats;
 * actual event handling will be implemented in later phases.
 */
export class ReverbService {
  constructor({
    url,
    apiKey,
    logger,
    reconnectDelayMs = 5000,
    heartbeatIntervalMs = 30000,
  }) {
    this.url = url;
    this.apiKey = apiKey;
    this.logger = logger;
    this.reconnectDelayMs = reconnectDelayMs;
    this.heartbeatIntervalMs = heartbeatIntervalMs;

    this.socket = null;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
  }

  connect() {
    if (!this.url) {
      this.logger.warn('Reverb URL not provided; skipping WebSocket connection.');
      return;
    }

    this.#clearReconnectTimer();
    this.logger.info(`Connecting to Reverb at ${this.url}`);

    this.socket = new WebSocket(this.url, {
      headers: {
        'X-API-Key': this.apiKey,
      },
    });

    this.socket.on('open', () => {
      this.logger.info('Reverb connection established.');
      this.#startHeartbeat();
    });

    this.socket.on('close', (code, reason) => {
      this.logger.warn(`Reverb connection closed (${code}): ${reason?.toString() ?? 'no reason'}`);
      this.#stopHeartbeat();
      this.#scheduleReconnect();
    });

    this.socket.on('error', (error) => {
      this.logger.error('Reverb connection error', error?.message ?? error);
    });

    // No event handling yet; this placeholder keeps the pipeline ready for future phases.
    this.socket.on('message', () => {
      this.logger.debug('Reverb message received (handlers not implemented in Phase 1).');
    });
  }

  #startHeartbeat() {
    this.#stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.ping();
        this.logger.debug('Sent Reverb heartbeat ping.');
      }
    }, this.heartbeatIntervalMs);
  }

  #stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  #scheduleReconnect() {
    if (this.reconnectTimer) {
      return;
    }

    this.logger.info(`Reconnecting to Reverb in ${this.reconnectDelayMs}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelayMs);
  }

  #clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
