import {
  createPrivateKey,
  randomUUID as cryptoRandomUUID,
  sign,
} from 'node:crypto';

const SNOWFLAKE_PATTERN = /^\d{17,20}$/;
const COMMAND_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;

export const RelayHeaders = Object.freeze({
  PAYLOAD: 'X-Nexus-Discord-Relay-Payload',
  SIGNATURE: 'X-Nexus-Discord-Relay-Signature',
  TIMESTAMP: 'X-Nexus-Discord-Relay-Timestamp',
});

export class DiscordRelaySigner {
  constructor({ privateKeyBase64, guildId, clock = Date.now, randomUUID = cryptoRandomUUID }) {
    if (!SNOWFLAKE_PATTERN.test(`${guildId ?? ''}`)) {
      throw new TypeError('Discord relay signing requires a valid configured guild snowflake.');
    }

    let privateKey;
    try {
      privateKey = createPrivateKey({
        key: Buffer.from(`${privateKeyBase64 ?? ''}`.trim(), 'base64'),
        format: 'der',
        type: 'pkcs8',
      });
    } catch {
      throw new TypeError('NEXUS_DISCORD_RELAY_PRIVATE_KEY must be a base64 PKCS#8 Ed25519 private key.');
    }

    if (privateKey.asymmetricKeyType !== 'ed25519') {
      throw new TypeError('NEXUS_DISCORD_RELAY_PRIVATE_KEY must contain an Ed25519 private key.');
    }

    this.privateKey = privateKey;
    this.guildId = `${guildId}`;
    this.clock = clock;
    this.randomUUID = randomUUID;
  }

  interactionHeaders(actor) {
    const userId = `${actor?.discordUserId ?? actor?.userId ?? ''}`.trim();
    const guildId = `${actor?.discordGuildId ?? actor?.guildId ?? ''}`.trim();
    const interactionId = `${actor?.discordInteractionId ?? actor?.interactionId ?? ''}`.trim();
    const command = `${actor?.discordCommand ?? actor?.command ?? 'interaction'}`.trim().toLowerCase();

    if (!SNOWFLAKE_PATTERN.test(userId) || !SNOWFLAKE_PATTERN.test(interactionId)) {
      throw new TypeError('Discord relay proof requires valid user and interaction snowflakes.');
    }
    if (!SNOWFLAKE_PATTERN.test(guildId) || guildId !== this.guildId) {
      throw new TypeError('Discord relay proof must use the configured guild.');
    }
    if (!COMMAND_PATTERN.test(command)) {
      throw new TypeError('Discord relay proof requires a valid command name.');
    }

    return {
      ...this.#signPayload({
        relay_version: 1,
        proof_type: 'interaction',
        id: interactionId,
        guild_id: guildId,
        member: { user: { id: userId } },
        data: this.#commandData(command),
      }),
      'X-Discord-User-ID': userId,
      'X-Discord-Guild-ID': guildId,
      'X-Discord-Interaction-ID': interactionId,
    };
  }

  serviceHeaders(action) {
    const normalizedAction = `${action ?? ''}`.trim().toLowerCase();
    if (!COMMAND_PATTERN.test(normalizedAction)) {
      throw new TypeError('Discord relay service proof requires a valid action.');
    }

    return this.#signPayload({
      relay_version: 1,
      proof_type: 'service',
      nonce: this.randomUUID(),
      guild_id: this.guildId,
      action: normalizedAction,
    });
  }

  #signPayload(payload) {
    const encodedPayload = JSON.stringify(payload);
    const timestamp = `${Math.floor(this.clock() / 1000)}`;
    const signature = sign(null, Buffer.from(timestamp + encodedPayload), this.privateKey);

    return {
      [RelayHeaders.PAYLOAD]: Buffer.from(encodedPayload).toString('base64url'),
      [RelayHeaders.SIGNATURE]: signature.toString('hex'),
      [RelayHeaders.TIMESTAMP]: timestamp,
    };
  }

  #commandData(command) {
    const [name, ...subcommands] = command.split('.');
    let options = [];

    for (const subcommand of subcommands.reverse()) {
      options = [{
        type: 1,
        name: subcommand,
        ...(options.length > 0 ? { options } : {}),
      }];
    }

    return {
      name,
      ...(options.length > 0 ? { options } : {}),
    };
  }
}
