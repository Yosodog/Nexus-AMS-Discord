import util from 'util';

/**
 * Structured logger with simple secret scrubbing.
 * Keeps output consistent and avoids leaking sensitive environment variables.
 */
export class Logger {
  /**
   * @param {string} context human-readable context to prefix every log line with
   */
  constructor(context = 'App') {
    this.context = context;
    this.secrets = this.#collectSecrets();
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
    const serialized =
      typeof input === 'string' ? input : util.inspect(input, { depth: 3, colors: false });

    // Prevent accidental leakage of secrets by redacting known sensitive values.
    return this.secrets.reduce((acc, secret) => acc.replaceAll(secret, '[REDACTED]'), serialized);
  }

  #collectSecrets() {
    const secretKeys = [
      'DISCORD_BOT_TOKEN',
      'DISCORD_CLIENT_ID',
      'DISCORD_GUILD_ID',
      'NEXUS_API_URL',
      'NEXUS_API_KEY',
      'REVERB_URL',
      'REVERB_KEY',
    ];

    return secretKeys
      .map((key) => process.env[key])
      .filter((value) => Boolean(value))
      .map((value) => String(value));
  }
}
