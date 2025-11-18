/**
 * Validate presence of required environment variables and exit with a clear message if any are missing.
 * @param {string[]} requiredKeys list of environment variable names that must be present
 * @param {{ error: Function }} [logger] optional logger with an error method; console.error is used otherwise
 */
export const validateEnv = (requiredKeys, logger) => {
  const missing = requiredKeys.filter((key) => !process.env[key] || process.env[key].trim() === '');

  if (missing.length === 0) {
    return;
  }

  const writer = logger?.error ? logger : console;
  writer.error(
    `Missing required environment variables: ${missing.join(', ')}. Please populate .env before starting the bot.`,
  );

  // Exit gracefully so hosting environments can detect misconfiguration instead of crashing noisily.
  process.exit(1);
};
