import {
  createPublicKey,
  createHash,
  verify as verifySignature,
} from 'node:crypto';

export const CONTRACT_SIGNING_DOMAINS = Object.freeze({
  'relay-proof': 'NEXUS-DISCORD-RELAY-PROOF-V2',
  'capability-manifest': 'NEXUS-DISCORD-CAPABILITY-MANIFEST-V1',
  'route-endorsement': 'NEXUS-DISCORD-ROUTE-ENDORSEMENT-V1',
  'delivery-batch': 'NEXUS-DISCORD-DELIVERY-BATCH-V1',
  'delivery-receipt': 'NEXUS-DISCORD-DELIVERY-RECEIPT-V1',
});

const UNRESERVED = /[A-Za-z0-9._~-]/;
const PATH_SAFE = /[A-Za-z0-9._~!$'()*+,;=:@/-]/;
const QUERY_SAFE = /[A-Za-z0-9._~!$'()*+,;:@/-]/;
const UPPERCASE_ESCAPE = /^%[0-9A-F]{2}$/;

const utf8Compare = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));

const encodeComponent = (value, { allowEquals = false } = {}) => {
  let encoded = '';
  for (const character of `${value}`) {
    if ((allowEquals && character === '=') || (QUERY_SAFE.test(character) && character !== '?')) {
      encoded += character;
      continue;
    }
    if (PATH_SAFE.test(character) && allowEquals) {
      encoded += character;
      continue;
    }
    const bytes = Buffer.from(character);
    for (const byte of bytes) encoded += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return encoded;
};

const normalizeEncodedComponent = (raw, { rejectEncodedUnreserved = true } = {}) => {
  let output = '';
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === '%') {
      const escape = raw.slice(index, index + 3);
      if (!UPPERCASE_ESCAPE.test(escape)) {
        throw new TypeError('Relay request target percent escapes must use uppercase hexadecimal.');
      }
      const decoded = String.fromCharCode(Number.parseInt(escape.slice(1), 16));
      if (UNRESERVED.test(decoded) && rejectEncodedUnreserved) {
        throw new TypeError('Relay request targets must not percent-encode unreserved characters.');
      }
      output += UNRESERVED.test(decoded) ? decoded : escape;
      index += 2;
      continue;
    }
    if (QUERY_SAFE.test(character)) {
      output += character;
      continue;
    }
    output += encodeComponent(character);
  }
  return output;
};

const normalizePath = (rawPath, options = {}) => {
  const path = `${rawPath || '/'}`;
  if (!path.startsWith('/') || /[\s\u0000-\u001F\u007F]/u.test(path)) {
    throw new TypeError('Relay request target must be an origin-form path.');
  }
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new TypeError('Relay request target must not contain dot path segments.');
  }

  let output = '';
  for (let index = 0; index < path.length; index += 1) {
    const character = path[index];
    if (character === '%') {
      const escape = path.slice(index, index + 3);
      if (!UPPERCASE_ESCAPE.test(escape)) {
        throw new TypeError('Relay request target percent escapes must use uppercase hexadecimal.');
      }
      const decoded = String.fromCharCode(Number.parseInt(escape.slice(1), 16));
      if (UNRESERVED.test(decoded) && options.rejectEncodedUnreserved !== false) {
        throw new TypeError('Relay request targets must not percent-encode unreserved characters.');
      }
      output += UNRESERVED.test(decoded) ? decoded : escape;
      index += 2;
      continue;
    }
    if (PATH_SAFE.test(character)) {
      output += character;
      continue;
    }
    output += encodeComponent(character, { allowEquals: true });
  }
  if (output.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new TypeError('Relay request target must not contain dot path segments.');
  }
  return output || '/';
};

const normalizeQuery = (rawQuery, options = {}) => {
  if (!rawQuery) return '';
  const pairs = `${rawQuery}`.split('&').map((pair) => {
    const delimiter = pair.indexOf('=');
    const rawKey = delimiter === -1 ? pair : pair.slice(0, delimiter);
    const rawValue = delimiter === -1 ? '' : pair.slice(delimiter + 1);
    if (!rawKey) throw new TypeError('Relay request query keys must not be empty.');
    if (rawValue.includes('=')) {
      throw new TypeError('Relay request query values must percent-encode the equals character.');
    }
    let key;
    let value;
    try {
      // decodeURIComponent intentionally leaves literal '+' unchanged.
      key = decodeURIComponent(rawKey);
      value = decodeURIComponent(rawValue);
    } catch {
      throw new TypeError('Relay request target contains invalid percent encoding.');
    }
    return {
      key,
      value,
      encodedKey: normalizeEncodedComponent(rawKey, options),
      encodedValue: normalizeEncodedComponent(rawValue, options),
      hasEquals: delimiter !== -1,
    };
  });

  pairs.sort((left, right) => utf8Compare(left.key, right.key) || utf8Compare(left.value, right.value));
  return pairs.map(({ encodedKey, encodedValue, hasEquals }) => (
    `${encodedKey}${hasEquals ? `=${encodedValue}` : ''}`
  )).join('&');
};

/** Normalize an absolute URL or origin-form target to the contract's exact path/query form. */
export const normalizePathQuery = (value, { rejectEncodedUnreserved = true } = {}) => {
  const input = value instanceof URL ? value.toString() : `${value ?? ''}`;
  if (!input || input.includes('#') || /[\s\u0000-\u001F\u007F]/u.test(input)) {
    throw new TypeError('Relay request target must not contain a fragment, whitespace, or control character.');
  }

  let target = input;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(input)) {
    const authorityStart = input.indexOf('://') + 3;
    const authoritySuffix = input.slice(authorityStart);
    const authorityEndOffset = authoritySuffix.search(/[/?#]/u);
    const authorityEnd = authorityEndOffset === -1 ? -1 : authorityStart + authorityEndOffset;
    const rawRest = authorityEnd === -1 ? '' : input.slice(authorityEnd);
    const rawAbsolutePath = rawRest.split(/[?#]/u, 1)[0] || '/';
    if (rawAbsolutePath.split('/').some((segment) => segment === '.' || segment === '..')) {
      throw new TypeError('Relay request target must not contain dot path segments.');
    }
    const url = new URL(input);
    if (url.username || url.password || url.hash) {
      throw new TypeError('Relay request target must not contain credentials or a fragment.');
    }
    target = `${url.pathname || '/'}${url.search}`;
  }

  if (!target.startsWith('/')) throw new TypeError('Relay request target must be an origin-form path.');
  const queryIndex = target.indexOf('?');
  const rawPath = queryIndex === -1 ? target : target.slice(0, queryIndex);
  const rawQuery = queryIndex === -1 ? '' : target.slice(queryIndex + 1);
  const options = { rejectEncodedUnreserved };
  const normalizedQuery = normalizeQuery(rawQuery, options);
  return `${normalizePath(rawPath, options)}${normalizedQuery ? `?${normalizedQuery}` : ''}`;
};

/** Serialize the exact request bytes used by Axios' JSON request transformer. */
export const serializeBody = (body) => {
  if (body === undefined || body === null) return '';
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return body;
  return JSON.stringify(body);
};

export const sha256Hex = (value) => {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(`${value ?? ''}`);
  return createHash('sha256').update(bytes).digest('hex');
};

/** RFC 8785-compatible canonical JSON for the contract value types. */
export const canonicalize = (value) => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON does not allow non-finite numbers.');
    return JSON.stringify(value);
  }
  if (typeof value === 'bigint' || typeof value === 'undefined' || typeof value === 'function') {
    throw new TypeError('Canonical JSON does not allow this value type.');
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
};

/** JSON.parse with duplicate object-member rejection for untrusted relay payloads. */
export const parseJsonNoDuplicateKeys = (input) => {
  const source = `${input ?? ''}`;
  let index = 0;
  const whitespace = () => {
    while (/\s/.test(source[index] ?? '')) index += 1;
  };
  const expect = (character) => {
    whitespace();
    if (source[index] !== character) throw new TypeError('Relay payload JSON is malformed.');
    index += 1;
  };
  const parseString = () => {
    whitespace();
    const start = index;
    if (source[index] !== '"') throw new TypeError('Relay payload JSON string is malformed.');
    index += 1;
    let escaped = false;
    while (index < source.length) {
      const character = source[index];
      if (escaped) {
        escaped = false;
        index += 1;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        index += 1;
        continue;
      }
      if (character === '"') {
        index += 1;
        const value = source.slice(start, index);
        return JSON.parse(value);
      }
      if (character < ' ') throw new TypeError('Relay payload JSON contains a control character.');
      index += 1;
    }
    throw new TypeError('Relay payload JSON string is unterminated.');
  };
  const parseValue = () => {
    whitespace();
    const character = source[index];
    if (character === '{') return parseObject();
    if (character === '[') return parseArray();
    if (character === '"') return parseString();
    const start = index;
    while (index < source.length && !/[\s,\]}]/.test(source[index])) index += 1;
    const token = source.slice(start, index);
    if (!['true', 'false', 'null'].includes(token) && !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(token)) {
      throw new TypeError('Relay payload JSON value is malformed.');
    }
    return JSON.parse(token);
  };
  const parseArray = () => {
    expect('[');
    const values = [];
    whitespace();
    if (source[index] === ']') {
      index += 1;
      return values;
    }
    while (true) {
      values.push(parseValue());
      whitespace();
      if (source[index] === ']') {
        index += 1;
        return values;
      }
      expect(',');
    }
  };
  const parseObject = () => {
    expect('{');
    const result = {};
    const keys = new Set();
    whitespace();
    if (source[index] === '}') {
      index += 1;
      return result;
    }
    while (true) {
      const key = parseString();
      if (keys.has(key)) throw new TypeError('Relay payload JSON contains duplicate object keys.');
      keys.add(key);
      expect(':');
      result[key] = parseValue();
      whitespace();
      if (source[index] === '}') {
        index += 1;
        return result;
      }
      expect(',');
    }
  };

  const parsed = parseValue();
  whitespace();
  if (index !== source.length) throw new TypeError('Relay payload JSON has trailing data.');
  return parsed;
};

const rawPublicKey = (value) => {
  if (value?.type === 'public') return value;
  const encoded = `${value ?? ''}`.trim();
  const bytes = Buffer.from(encoded.replaceAll('-', '+').replaceAll('_', '/'), 'base64');
  if (bytes.length !== 32) throw new TypeError('Relay public key must be a raw Ed25519 key.');
  return createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), bytes]),
    format: 'der',
    type: 'spki',
  });
};

export const publicKeyFromBase64Url = rawPublicKey;

export const verifySignedContract = (
  document,
  publicKey,
  { expected = {}, now = Date.now(), maxClockSkewSeconds = 60 } = {},
) => {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return { valid: false, reason: 'malformed_document' };
  }
  const signature = document.signature;
  if (signature?.algorithm !== 'ed25519' || !/^[a-f0-9]{128}$/.test(`${signature?.value ?? ''}`)) {
    return { valid: false, reason: 'invalid_signature' };
  }
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (expectedValue !== undefined && document[field] !== expectedValue) {
      return { valid: false, reason: `binding_${field}` };
    }
  }

  const domain = CONTRACT_SIGNING_DOMAINS[document.contract];
  if (!domain || !Number.isInteger(document.contract_version)) {
    return { valid: false, reason: 'unknown_contract' };
  }
  const { signature: _signature, ...unsigned } = document;
  const signingInput = `${domain}\n${canonicalize(unsigned)}`;
  let verified = false;
  try {
    verified = verifySignature(
      null,
      Buffer.from(signingInput),
      rawPublicKey(publicKey),
      Buffer.from(signature.value, 'hex'),
    );
  } catch {
    return { valid: false, reason: 'invalid_public_key' };
  }
  if (!verified) return { valid: false, reason: 'signature_mismatch' };

  const issuedAt = Date.parse(document.issued_at ?? document.received_at ?? '');
  const expiresAt = Date.parse(document.expires_at ?? '');
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
    return { valid: false, reason: 'invalid_lifetime' };
  }
  const skew = maxClockSkewSeconds * 1000;
  if (issuedAt > now + skew || expiresAt < now - skew) return { valid: false, reason: 'stale_contract' };
  return { valid: true, document };
};

export const selectKeyFromSet = (keySet, keyId) => {
  if (!keySet || keySet.scope === undefined) return null;
  if (keySet.current?.key_id === keyId) return keySet.current;
  if (keySet.next?.key_id === keyId) return keySet.next;
  return null;
};
