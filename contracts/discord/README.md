# Discord relay public contracts

This directory is the WP0 public contract surface for the Discord relay. The
version in each filename is part of the compatibility promise. Every document
also carries the closed discriminator pair `contract` and `contract_version`:

| Artifact | `contract` | `contract_version` | Direction |
| --- | --- | ---: | --- |
| `relay-proof-v2.schema.json` | `relay-proof` | 2 | relay -> API |
| `capability-manifest-v1.schema.json` | `capability-manifest` | 1 | relay -> API |
| `route-endorsement-v1.schema.json` | `route-endorsement` | 1 | API -> relay |
| `delivery-batch-v1.schema.json` | `delivery-batch` | 1 | API -> relay |
| `delivery-receipt-v1.schema.json` | `delivery-receipt` | 1 | relay -> API |

The schemas use JSON Schema draft-07, inline their definitions, and do not
depend on a shared protocol package or remote `$ref`. That keeps the fixtures
usable by PHP, Node, and cloud conformance runners without a resolver setup.
Envelope objects are closed with `additionalProperties: false`. A delivery's
`payload` is the intentional extension boundary: it is action-specific data,
limited to 32 lower-snake-case property names and separately validated by the
endorsed route. Credentials are not allowed there.

## Shared binding

Every contract binds the same five values:

- `connection_id` is the canonical lower-case UUID for one relay connection.
- `app_id` and `guild_id` are Discord snowflakes represented as strings. A
  relay is never authorized for a caller-supplied guild outside this value.
- `generation` is a positive binding generation. Increment it when the app,
  guild, connection, route set, or accepted key set changes.
- `key_id` identifies the Ed25519 public key used for this document's
  signature. It must be present in the latest accepted manifest for the exact
  `(connection_id, app_id, guild_id, generation)` tuple.

JSON Schema deliberately does not try to compare values across documents or
compare two fields for equality. Implementations must reject a mismatched
binding, stale generation, unknown key, or key that is not valid for the
document's direction even when the JSON shape is otherwise valid.

WP0 assumes one binding-key namespace is trusted by both peers for these
artifacts. It does not yet model separate API-owned and relay-owned issuer key
sets; if deployment requires that split, the coordinator must approve an
explicit issuer/key-scope discriminator and a second rotation set before
runtime integration.

## Canonicalization and signatures

All signed contracts contain a `signature` object with `algorithm: "ed25519"`
and a lower-case 128-character hexadecimal detached signature. The signature
is calculated over the document after removing the complete `signature`
property:

1. Parse JSON and reject duplicate object keys.
2. Remove `signature` from the top-level object.
3. Serialize the result with RFC 8785 JSON Canonicalization Scheme (JCS), as
   UTF-8, with no whitespace. Object member ordering is therefore not the
   producer's insertion order.
4. Prefix the canonical bytes with the ASCII domain separator, including its
   final newline:

   ```text
   NEXUS-DISCORD-RELAY-PROOF-V2\n
   ```

   The corresponding prefixes for the v1 signed artifacts are
   `NEXUS-DISCORD-CAPABILITY-MANIFEST-V1\n`,
   `NEXUS-DISCORD-ROUTE-ENDORSEMENT-V1\n`,
   `NEXUS-DISCORD-DELIVERY-BATCH-V1\n`, and
   `NEXUS-DISCORD-DELIVERY-RECEIPT-V1\n`.
5. Sign the prefix plus canonical bytes with the Ed25519 private key selected
   by `key_id`; encode the 64-byte result as lower-case hex.

The deterministic relay vector is
`fixtures/valid/relay-proof-v2.interaction.json`. Its expected canonical
bytes and signature are asserted in `test/discord-contracts.test.js`; the
test uses a fixed test-only key and does not access the network. The private
key used to derive that vector is not a deployment credential.

Timestamps are RFC 3339 UTC strings ending in `Z`. Producers must use safe
integers only and must not use a floating-point value where an integer is
specified. Canonical bytes are the signed input; a transport's pretty-printed
or reordered JSON is not.

## Stable states, errors, and limits

State and error strings are part of the public contract. Unknown values are
protocol errors, not free-form states.

- Proof `proof.type`: `interaction` or `service`.
- Delivery batch `state`: `leased`.
- Receipt `state`: `accepted`, `partial`, `rejected`, or `duplicate`.
- Receipt item state: `delivered`, `duplicate`, `retryable`, `rejected`, or
  `expired`.
- Receipt error codes: `discord_api_error`, `discord_forbidden`,
  `discord_rate_limited`, `discord_timeout`, `discord_unavailable`, `expired`,
  `internal_error`, `invalid_delivery`, `invalid_lease`,
  `payload_too_large`, and `unsupported_route`.

The v1 hard limits are:

| Limit | Value |
| --- | ---: |
| Relay-proof canonical document | 64 KiB |
| Capability manifest | 64 KiB |
| Route endorsement | 16 KiB |
| Delivery batch | 1 MiB |
| Delivery receipt | 256 KiB |
| Deliveries per batch/receipt | 100 |
| Delivery attempts | 3 |
| Proof lifetime | 300 seconds |
| Accepted clock skew | 60 seconds |
| Manifest lifetime | 24 hours |
| Endorsement lifetime | 300 seconds |
| Lease lifetime | 300 seconds |
| Dedupe window | 24 hours |
| Receipt error message | 512 bytes/characters, no newlines |

The `limits` object in the capability manifest advertises values at or below
these ceilings. The byte limits are transport/parser limits and cannot be
expressed by JSON Schema alone. `issued_at`/`expires_at` ordering, maximum
lifetimes, lease containment, and receipt/batch item-set equality are semantic
validation requirements.

## Key rotation

`capability-manifest-v1.keys.current` is required. `keys.next` is either a
complete Ed25519 public key with a future `activates_at` or `null` during a
steady state. The manifest's `key_id` and signature use `current.key_id`.

During a rotation overlap, consumers accept signatures made with the current
key and the announced next key only for the exact binding and generation. The
next key must have a distinct `key_id`, a future activation time, and a new
generation before promotion. After promotion, publish a new manifest with the
promoted key as `current`; retire the old key only after its maximum accepted
TTL and dedupe window have elapsed. Unknown, retired, or cross-generation keys
must fail closed. Private keys never appear in a manifest, fixture, log, or
receipt.

## Idempotency and deduplication

- `idempotency_key` identifies one signed submission. Retrying the same
  canonical bytes with the same binding and key must be safe and return the
  original result; reusing it with different bytes is a conflict.
- `batch_id` identifies a delivery batch, while each delivery has a stable
  `delivery_id` and `dedupe_key`. A relay may receive a batch more than once.
- A relay must deduplicate a delivery by `(connection_id, generation,
  delivery_id, dedupe_key)` for the dedupe window, and should use a stable
  Discord nonce derived from that key for side effects.
- A receipt is retriable by `receipt_id`/`idempotency_key`. Replaying an
  identical receipt is harmless; replaying a changed receipt under the same
  idempotency key is rejected. Each `delivery_id` appears at most once per
  receipt, and a receipt may not acknowledge a different binding or lease.
- `duplicate` is a successful terminal outcome: it means the side effect was
  already applied or the same receipt was already accepted. It is not a retry.

## Redaction and logging

Never put API keys, bot tokens, OAuth tokens, cookies, passwords, private keys,
authorization headers, raw relay headers, or arbitrary secret-bearing values
in these contracts. The delivery payload schema rejects common credential
property names as a second boundary, but producers remain responsible for
redacting nested or encoded secrets before signing. User-facing content may be
carried only when required by the endorsed action and should not be copied to
logs.

Logs and error reports may include contract name/version, binding identifiers,
route ID, batch/delivery/receipt IDs, state, error code, and attempt number.
They must redact signature values, lease tokens, idempotency material when it
could be sensitive, payload bodies, URLs with credentials, and all key
material. `error_message` is diagnostic text only; it is not a place for a
stack trace, token, request body, or secret.
