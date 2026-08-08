import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.google',
  'instance-data',
  'instance-data.ec2.internal',
]);

const IPV6_BITS = 128n;
const IPV4_BITS = 32n;
const ipv4Number = (value) => value.split('.').reduce((result, octet) => (result * 256) + Number(octet), 0);

const privateIpv4 = (value) => {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return false;
  const octets = value.split('.').map(Number);
  if (octets.some((octet) => octet > 255)) return true;
  const number = ipv4Number(value);
  const inRange = (start, end) => number >= start && number <= end;
  return inRange(0x00000000, 0x00ffffff) // this network / unspecified
    || inRange(0x0a000000, 0x0affffff) // RFC 1918
    || inRange(0x64400000, 0x647fffff) // carrier-grade NAT
    || inRange(0x7f000000, 0x7fffffff) // loopback
    || inRange(0xa9fe0000, 0xa9feffff) // link-local / metadata
    || inRange(0xac100000, 0xac1fffff) // RFC 1918
    || inRange(0xc0000000, 0xc00000ff) // IETF protocol assignments
    || inRange(0xc0000200, 0xc00002ff) // TEST-NET-1
    || inRange(0xc0a80000, 0xc0a8ffff) // RFC 1918
    || inRange(0xc6120000, 0xc613ffff) // benchmark / documentation
    || inRange(0xc6336400, 0xc63364ff) // TEST-NET-2
    || inRange(0xcb007100, 0xcb0071ff) // TEST-NET-3
    || inRange(0xe0000000, 0xffffffff); // multicast / reserved
};

const parseIpv6 = (value) => {
  const normalized = `${value}`.toLowerCase();
  if (normalized.includes('%')) return null;
  const sections = normalized.split('::');
  if (sections.length > 2) return null;
  const parseSection = (section) => (section ? section.split(':').flatMap((part, index, parts) => {
    if (part.includes('.')) {
      if (index !== parts.length - 1 || net.isIP(part) !== 4) return [null];
      const octets = part.split('.').map(Number);
      const ipv4 = octets.reduce((result, octet) => (result * 256) + octet, 0);
      return [(ipv4 >>> 16) & 0xffff, ipv4 & 0xffff];
    }
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    return [Number.parseInt(part, 16)];
  }) : []);
  const head = parseSection(sections[0]);
  const tail = sections.length === 2 ? parseSection(sections[1]) : [];
  if (head.includes(null) || tail.includes(null)) return null;
  const missing = sections.length === 2 ? 8 - head.length - tail.length : 0;
  if ((sections.length === 1 && head.length !== 8) || (sections.length === 2 && missing < 1)) return null;
  return [...head, ...Array.from({ length: missing }, () => 0), ...tail]
    .reduce((result, part) => (result << 16n) | BigInt(part), 0n);
};

const inIpv6Range = (number, prefix, bits) => {
  const width = BigInt(bits);
  const mask = ((1n << width) - 1n) << (IPV6_BITS - width);
  return (number & mask) === prefix;
};

const publicIpv6 = (value) => {
  const number = parseIpv6(value);
  if (number === null) return false;
  if (number === 0n || number === 1n) return false; // unspecified / loopback

  const mappedPrefix = number >> IPV4_BITS;
  if (mappedPrefix === 0xffffn) {
    const mappedIpv4 = Number(number & ((1n << IPV4_BITS) - 1n));
    const octets = [
      (mappedIpv4 >>> 24) & 0xff,
      (mappedIpv4 >>> 16) & 0xff,
      (mappedIpv4 >>> 8) & 0xff,
      mappedIpv4 & 0xff,
    ].join('.');
    return !privateIpv4(octets);
  }
  if (mappedPrefix === 0n) return false; // deprecated IPv4-compatible / unspecified space

  return !inIpv6Range(number, 0xfc000000000000000000000000000000n, 7) // ULA
    && !inIpv6Range(number, 0xfe800000000000000000000000000000n, 10) // link-local
    && !inIpv6Range(number, 0xff000000000000000000000000000000n, 8) // multicast
    && !inIpv6Range(number, 0x20010000000000000000000000000000n, 32) // Teredo
    && !inIpv6Range(number, 0x20010002000000000000000000000000n, 48) // benchmarking
    && !inIpv6Range(number, 0x20010010000000000000000000000000n, 28) // ORCHID
    && !inIpv6Range(number, 0x20010020000000000000000000000000n, 28) // ORCHIDv2
    && !inIpv6Range(number, 0x20010db8000000000000000000000000n, 32) // documentation
    && !inIpv6Range(number, 0x20020000000000000000000000000000n, 16) // 6to4
    && !inIpv6Range(number, 0x3ffe0000000000000000000000000000n, 16) // 6bone
    && !inIpv6Range(number, 0x0064ff9b000000000000000000000000n, 96) // NAT64 well-known prefix
    && !inIpv6Range(number, 0x0100000000000000n << 64n, 64); // discard prefix
};

const normalizedHostname = (hostname) => `${hostname ?? ''}`
  .trim()
  .toLowerCase()
  .replace(/^\[|\]$/g, '')
  .replace(/\.$/, '');

export const isPublicHost = (hostname) => {
  const normalized = normalizedHostname(hostname);
  if (!normalized || BLOCKED_HOSTNAMES.has(normalized)) return false;
  if (normalized.endsWith('.localhost') || normalized.endsWith('.local') || normalized.endsWith('.internal')) return false;
  if (/^\d+$/.test(normalized) || /^0x[0-9a-f]+$/i.test(normalized) || /^0[0-7]+$/.test(normalized)) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(normalized) && normalized.split('.').some((part) => part.length > 1 && part.startsWith('0'))) {
    return false;
  }
  const type = net.isIP(normalized);
  if (type === 4) return !privateIpv4(normalized);
  if (type === 6) return publicIpv6(normalized);
  if (/^[0-9.]+$/.test(normalized)) return false;
  return true;
};

export const validateNexusEndpoint = (value, { shared = false } = {}) => {
  let url;
  try {
    url = new URL(`${value ?? ''}`);
  } catch {
    throw new TypeError('Nexus endpoint must be an absolute HTTP(S) URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new TypeError('Nexus endpoint must be an origin-only HTTP(S) URL without credentials or fragments.');
  }
  if (url.pathname !== '/' || url.search) {
    throw new TypeError('Nexus endpoint must not contain a path or query.');
  }
  if (shared && url.protocol !== 'https:') {
    throw new TypeError('Shared Nexus endpoints must use HTTPS.');
  }
  if (shared && !isPublicHost(url.hostname)) {
    throw new TypeError('Shared Nexus endpoint host is not a public host.');
  }
  return url.origin;
};

export const assertPublicDnsResults = (addresses) => {
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new TypeError('Nexus endpoint DNS resolution returned no addresses.');
  }
  if (addresses.some((entry) => !isPublicHost(entry?.address ?? entry))) {
    throw new TypeError('Nexus endpoint DNS resolution returned a private or reserved address.');
  }
  return addresses;
};

const normalizeLookupResult = (result) => {
  const values = Array.isArray(result) ? result : [result];
  return values.filter(Boolean).map((entry) => {
    if (typeof entry === 'string') return { address: entry, family: net.isIP(entry) };
    return { address: entry.address, family: Number(entry.family) || net.isIP(entry.address) };
  });
};

const resolvePublicAddresses = async (lookup, hostname) => {
  const result = await lookup(hostname, { all: true, verbatim: true });
  return assertPublicDnsResults(normalizeLookupResult(result));
};

/**
 * Create a per-connection HTTPS agent that performs a fresh, fail-closed DNS
 * lookup for every socket. TLS still verifies the original hostname because
 * lookup only substitutes the socket address; SNI and certificate checks use
 * the URL hostname.
 */
export const createPublicHttpsAgent = (
  endpoint,
  { lookup = dns.lookup, maxSockets = 32 } = {},
) => {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:') throw new TypeError('A public HTTPS agent requires an HTTPS endpoint.');
  const expectedHostname = normalizedHostname(url.hostname);
  const lookupForAgent = (hostname, options, callback) => {
    Promise.resolve()
      .then(async () => {
        if (normalizedHostname(hostname) !== expectedHostname) {
          throw new TypeError('HTTPS agent lookup hostname does not match the connection endpoint.');
        }
        const addresses = await resolvePublicAddresses(lookup, hostname);
        const requestedFamily = Number(options?.family) || 0;
        const candidates = requestedFamily === 0
          ? addresses
          : addresses.filter((entry) => entry.family === requestedFamily);
        if (candidates.length === 0) throw new TypeError('Nexus endpoint DNS resolution returned no usable addresses.');
        return options?.all ? candidates : candidates[0];
      })
      .then((result) => {
        if (options?.all) callback(null, result);
        else callback(null, result.address, result.family);
      })
      .catch((error) => callback(error));
  };

  return new https.Agent({
    keepAlive: false,
    maxSockets,
    maxFreeSockets: 0,
    maxCachedSessions: 0,
    rejectUnauthorized: true,
    servername: expectedHostname,
    lookup: lookupForAgent,
  });
};
