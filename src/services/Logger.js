import util from 'util';

const LEVELS = Object.freeze({ DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 });
const SENSITIVE_KEY = /token|secret|password|authorization|cookie|credential|api.?key|lease/i;

/**
 * Structured logger with simple secret scrubbing.
 * Keeps output consistent and avoids leaking sensitive environment variables.
 */
export class Logger {
  /**
   * @param {string} context human-readable context to prefix every log line with
   */
  constructor(context = 'App', { level = process.env.LOG_LEVEL } = {}) {
    this.context = context;
    this.secrets = this.#collectSecrets();
    const defaultLevel = process.env.NODE_ENV === 'production' ? 'INFO' : 'DEBUG';
    this.level = `${level ?? defaultLevel}`.trim().toUpperCase();
    if (!(this.level in LEVELS)) {
      this.level = defaultLevel;
    }
  }

  info(...args) {
    this.#log('INFO', ...args);
  }

  warn(...args) {
    this.#log('WARN', ...args);
  }

  error(...args) {
    this.#log('ERROR', ...args);
  }

  debug(...args) {
    this.#log('DEBUG', ...args);
  }

  #log(level, ...args) {
    if (LEVELS[level] < LEVELS[this.level]) {
      return;
    }

    const timestamp = new Date().toISOString();
    const payload = args.map((arg) => this.#sanitize(arg)).join(' ');
    const message = `[${timestamp}] [${level}] [${this.context}] ${payload}`;

    if (level === 'ERROR') {
      console.error(message);
    } else if (level === 'WARN') {
      console.warn(message);
    } else {
      console.log(message);
    }
  }

  #sanitize(input) {
    input = this.#redactKeys(input);

    const serialized =
      typeof input === 'string' ? input : util.inspect(input, { depth: 3, colors: false });

    // Prevent accidental leakage of secrets by redacting known sensitive values.
    const withoutCredentials = serialized
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
      .replace(/([?&][^=\s]+)=([^&\s]+)/g, '$1=[REDACTED]');
    return this.secrets.reduce((acc, secret) => acc.replaceAll(secret, '[REDACTED]'), withoutCredentials);
  }

  #redactKeys(input, seen = new WeakSet()) {
    if (input instanceof Error) {
      return {
        name: input.name,
        message: input.message,
        code: input.code ?? null,
        status: input.response?.status ?? null,
      };
    }
    if (!input || typeof input !== 'object') return input;
    if (seen.has(input)) return '[Circular]';
    seen.add(input);
    if (Array.isArray(input)) return input.map((value) => this.#redactKeys(value, seen));
    const clone = {};
    for (const [key, value] of Object.entries(input)) {
      clone[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : this.#redactKeys(value, seen);
    }
    return clone;
  }

  #collectSecrets() {
    const secretKeys = [
      'DISCORD_BOT_TOKEN',
      'NEXUS_API_KEY',
      'NEXUS_DISCORD_RELAY_PRIVATE_KEY',
    ];

    return secretKeys
      .map((key) => process.env[key])
      .filter((value) => Boolean(value))
      .map((value) => String(value));
  }
}
