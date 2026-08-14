import { generateKeyPairSync } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privateDer = privateKey.export({ format: 'der', type: 'pkcs8' });
const publicDer = publicKey.export({ format: 'der', type: 'spki' });
const rawPublicKey = publicDer.subarray(-32);

process.stdout.write([
  `NEXUS_DISCORD_RELAY_PRIVATE_KEY=${privateDer.toString('base64')}`,
  `DISCORD_RELAY_CURRENT_PUBLIC_KEY=${rawPublicKey.toString('base64url')}`,
  '',
].join('\n'));
