/**
 * Centralized configuration wrapper so the rest of the app never reads
 * process.env directly. Expect dotenv to be loaded before importing this file.
 */
export const config = {
  discord: {
    token: process.env.DISCORD_BOT_TOKEN ?? '',
    clientId: process.env.DISCORD_CLIENT_ID ?? '',
    guildId: process.env.DISCORD_GUILD_ID ?? '',
  },
  nexusApi: {
    baseUrl: process.env.NEXUS_API_URL ?? '',
    apiKey: process.env.NEXUS_API_KEY ?? '',
  },
};
