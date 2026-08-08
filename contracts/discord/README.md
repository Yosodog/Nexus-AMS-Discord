# Discord relay public contracts

This directory is the WP0 public contract surface for the Discord relay. The
version in each filename is part of the compatibility promise. Every signed
document carries the closed discriminator pair `contract` and
`contract_version`, plus explicit `issuer`, `audience`, and `key_scope`:

| Artifact | Direction | Key scope |
| --- | --- | --- |
| `relay-proof-v2.schema.json` | `discord-relay` -> `nexus` | `discord-relay->nexus` |
| `capability-manifest-v1.schema.json` | bidirectional | issuer/direction selected in the document |
| `route-endorsement-v1.schema.json` | `nexus` -> `discord-relay` | `nexus->discord-relay` |
| `delivery-batch-v1.schema.json` | `nexus` -> `discord-relay` | `nexus->discord-relay` |
| `delivery-receipt-v1.schema.json` | `discord-relay` -> `nexus` | `discord-relay->nexus` |

The schemas use JSON Schema draft-07, inline their definitions, and do not
depend on a shared protocol package or remote `$ref`. That keeps the fixtures
usable by PHP, Node, and cloud conformance runners without a resolver setup.
Envelope objects are closed with `additionalProperties: false`. A delivery's
`payload` is the intentional extension boundary: it is action-specific data,
limited to 32 lower-snake-case property names and separately validated by the
endorsed route. Credentials are not allowed there.

## Binding, authority, and manifest directions

Every artifact binds these values:

- `connection_id` is the canonical lower-case UUID for one accepted relay
  connection.
- `app_id` and `guild_id` are Discord snowflakes represented as strings. A
  relay is never authorized for a caller-supplied guild outside this value.
- `generation` is a positive binding generation. Increment it when the app,
  guild, connection, route set, or accepted key set changes.
- `key_scope` identifies the issuer-owned direction-specific key set:
  `discord-relay->nexus` or `nexus->discord-relay`. `key_id` is resolved only
  inside that scope; there is no shared key namespace.

Trust anchors come from the two-sided connection handshake and the accepted
connection record. A capability manifest is authenticated with an already
trusted key and cannot bootstrap trust in its own key set. Implementations
must reject a mismatched issuer/audience pair, stale generation, unknown key,
or key outside the accepted `(connection_id, app_id, guild_id, key_scope)`
record even when the JSON shape is valid.

`capability-manifest-v1` has two deliberately different shapes:

- A `discord-relay` -> `nexus` manifest contains `supported_queue_actions` and
  `renderers`; it does not contain `http_routes`.
- A `nexus` -> `discord-relay` manifest contains HTTP `http_routes`; each
  route uses a `path_template` and capability; it does not contain queue
  actions or renderers.

Each manifest carries an issuer-owned `key_set` with an owner, scope,
`current` key, and optional `next` key. The two directions rotate
independently and are never inferred from one another.

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
   final newline. The prefixes are:

   ```text
   NEXUS-DISCORD-RELAY-PROOF-V2\n
   NEXUS-DISCORD-CAPABILITY-MANIFEST-V1\n
   NEXUS-DISCORD-ROUTE-ENDORSEMENT-V1\n
   NEXUS-DISCORD-DELIVERY-BATCH-V1\n
   NEXUS-DISCORD-DELIVERY-RECEIPT-V1\n
   ```

5. Sign the prefix plus canonical bytes with the Ed25519 private key selected
   by the document's `key_scope` and `key_id`; encode the 64-byte result as
   lower-case hex.

### Exact request target normalization

`relay-proof-v2.normalized_path_query` is the exact normalized origin-form
request target. It is not a route template and is signed alongside `method`
and `body_sha256`.

- It begins with `/` and contains only path plus an optional query. It has no
  scheme, host, fragment, control character, or whitespace.
- Unreserved characters remain literal. A percent escape is exactly `%` plus
  two uppercase hexadecimal digits; spaces use `%20`, never `+`. Literal `+`
  remains `+`.
- A query is `key[=value]` pairs separated by `&`. Keys are non-empty; `=`
  is the one key/value delimiter and encoded data uses `%3D`. Pairs are sorted
  lexicographically by decoded UTF-8 key bytes and then decoded value bytes.
  Duplicate pairs are retained, including their multiplicity; they are never
  collapsed or treated as a set.
- A fragment is always rejected. Lowercase percent escapes, unsorted pairs,
  ambiguous `+` handling, or a changed duplicate count produce a different
  signed target and must not be normalized silently.

Capability and endorsement route templates use `path_template`, may contain
named `{parameters}`, and never contain a query. A template describes an
allowlisted route shape; it is not substituted into or compared as the actual
`normalized_path_query` until endpoint-specific semantic validation.

The deterministic relay vector is
`fixtures/valid/relay-proof-v2.interaction.json`. Its expected canonical
bytes and signature are asserted in `test/discord-contracts.test.js`, along
with query-order and action tamper checks. The test uses a fixed test-only key
and does not access the network. That private key is not a deployment
credential.

Timestamps are RFC 3339 UTC strings ending in `Z`. Producers must use safe
integers only and must not use floating-point values where an integer is
specified. Canonical bytes are the signed input; pretty-printed or reordered
transport JSON is not.

An interaction proof signs both the Discord root `command` and its canonical
lower-case dotted `action` (for example `applications` plus
`applications.approve`). A service proof signs its service `action` and a
unique `nonce`. Neither field may be inferred after verification.

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
| Delivery attempts | 8 |
| Proof lifetime | 300 seconds |
| Accepted clock skew | 60 seconds |
| Manifest lifetime | 24 hours |
| Endorsement lifetime | 300 seconds |
| Lease lifetime | 300 seconds |
| Dedupe window | 24 hours |
| Receipt error message | 512 bytes/characters, no newlines |

The `limits` object in either capability manifest advertises values at or
below these ceilings, including `max_delivery_attempts: 8`. Byte limits are
transport/parser limits and cannot be expressed by JSON Schema alone.
`issued_at`/`expires_at` ordering, maximum lifetimes, lease containment,
binding equality, route-template matching, and receipt/batch item-set equality
are semantic validation requirements.

## Key rotation

Rotation is independent per `key_scope`. Each accepted connection record has
separate issuer-owned current/next sets for `discord-relay->nexus` and
`nexus->discord-relay`. The current key is required; next is either a complete
Ed25519 public key with a future `activates_at` or `null` during steady state.

During a rotation overlap, consumers accept current and announced next keys
only inside the matching scope, binding, and generation. The next key must
have a distinct `key_id` and public key. After promotion, publish a new
accepted manifest with the promoted key as current; retire the old key only
after its maximum accepted TTL and dedupe window have elapsed. Unknown,
retired, cross-direction, or self-announced keys fail closed. Private keys
never appear in a manifest, fixture, log, or receipt.

## Idempotency and deduplication

- `idempotency_key` identifies one signed submission. Retrying the same
  canonical bytes with the same binding, issuer, audience, and scoped key is
  safe; reusing it with different bytes is a conflict.
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

Logs and error reports may include contract name/version, issuer, audience,
key scope, binding identifiers, route ID, batch/delivery/receipt IDs, state,
error code, and attempt number. They must redact signature values, lease
tokens, idempotency material when it could be sensitive, payload bodies, URLs
with credentials, and all key material. `error_message` is diagnostic text
only; it is not a place for a stack trace, token, request body, or secret.
