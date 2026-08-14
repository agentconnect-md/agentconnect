# Key Server — Dynamic Provider-Credential Issuance

**Status:** contract declared (`@agentconnect.md/protocol` `key-server.ts`); daemon
consumption not yet wired. This document is the contract's semantics — the parts a
schema cannot carry.

## 1. Why a seam

Today an AI-provider credential reaches a runtime one way: statically, as runtime
env in the daemon's config (or, for cluster spawn, baked into the SandboxTemplate).
That is the right default for a person running a daemon next to their own key, and
it stays supported forever — the key-server address is optional config, and absent
means "use the static key, we don't decide for users".

What a static key cannot express is a deployment that wants credentials to be
**issued**: short-lived and session-scoped so a leaked one is worthless, rotated
centrally with nobody reconfiguring daemons, revocable, or attributed so usage can
be metered per org/agent/session on the issuing side. All of those are one
operation from the daemon's point of view — "give me a credential for this
session" — so the seam is one small service contract, `agentconnect.key-server/v1`,
and every issuing strategy lives behind it. A deployment may implement it with a
plain vault that hands out rotating real keys, or with an LLM egress gateway that
issues its own gateway-scoped credentials and meters traffic on its data path. The
daemon cannot tell the difference, by design: it receives an opaque
`(key, baseUrl)` pair and injects it exactly like the static pair it replaces.

The contract deliberately carries **no quota, metering, or gateway concepts**.
Attribution context goes in (org/agent/session), a credential comes out; everything
an implementation does with that context is its own business, on its own side of
the seam.

## 2. Operations

Two RPC-style **plain HTTPS request/response** operations, JSON bodies, schemas in
[`packages/protocol/src/key-server.ts`](../../packages/protocol/src/key-server.ts).
This is deliberately not the daemon↔CP WebSocket or a frame group: issuance is a
low-frequency, stateless exchange, and a bare REST surface lets any deployment
implement the server without speaking AgentConnect's wire protocol.

| Operation   | Route                 | Body → Response                                                                                            |
| ----------- | --------------------- | ---------------------------------------------------------------------------------------------------------- |
| `GetKey`    | `POST /v1/get-key`    | `{orgId, agentId, sessionId, provider, ttlSeconds?}` → `{keyId, key, baseUrl?, expiresAt?, refreshAfter?}` |
| `RevokeKey` | `POST /v1/revoke-key` | `{keyId}` → `{}`                                                                                           |

**Caller authentication rides the transport, never the body**: the daemon sends
`Authorization: Bearer <token>`. To the daemon the token is an opaque string from
a configured source — a file it re-reads per request (so a credential something
else rotates underneath it stays current), or an inline config value. It parses
nothing, asserts nothing about what the token means, and holds no verification
logic.

`daemonId` is deliberately not a body field: a client-asserted identity would be
untrusted input, and a server that can verify the bearer at all can derive the
caller from it. `orgId` IS in the body, and a server that resolves an
organization from the token should cross-check the two.

**What the token is, and how a server verifies it, are outside this contract.**
They are properties of a deployment: which credential the daemon is given, what
proves it, and what the server must hold to check it are decided together by the
key server's own design and the deployment that installs both. This document
stops at the header. A server may accept only the credential kinds it is built
for and answer `unauthorized` for anything else; saying which is that server's
documentation, not this one's.

`provider` names the API dialect the credential must speak (`anthropic` /
`openai`) and selects which `(key, baseUrl)` pair comes back. There is
deliberately **no `model` parameter**: per-model usage attribution belongs to
whatever observes actual requests (a gateway data path, or the runtime's own usage
reports), and a spawn-time hint would invite implementations to treat it as truth
the daemon does not have — a runtime switches models mid-session.

## 3. Validity: the narrowing rule

`ttlSeconds` is the caller's desired validity, relative to avoid clock skew;
absent means the caller asks for a **long-lived key** it will manage explicitly.
The server may only narrow, never widen:

- request with `ttlSeconds` ⇒ response MUST carry `expiresAt`, at or before the
  requested horizon (`keyGrantViolation` in the contract makes this executable);
- request without `ttlSeconds` ⇒ response MAY omit `expiresAt`; an omitted
  `expiresAt` means no refresh loop runs and the degradation window below does
  not apply;
- `refreshAfter` is a renew-from hint and is only legal alongside `expiresAt`,
  strictly before it. Daemons renew inside `[refreshAfter, expiresAt)` instead of
  inventing their own margin.

## 4. Injection: one precedence chain, pairs never split

The response pair is atomic with respect to injection — a dynamic key must never
be combined with a static base URL or vice versa (a gateway credential aimed at a
public endpoint 401s; a real key aimed at a gateway bypasses whatever the
deployment put there). The daemon resolves the pair for a spawn top-down and takes
the first layer that yields a key, whole:

1. `GetKey` response — when a key-server address is configured;
2. the daemon's static config pair — when no key-server is configured;
3. the runtime's default public endpoint with whatever credential the runtime
   environment already carries.

Within a layer, an absent `baseUrl` falls through to the next layer's URL — that
is the one sanctioned mix, so a key-server that only rotates keys and fronts no
gateway needs no URL opinion.

## 5. Caching, rotation, and revocation

- **Cache within a session, re-fetch per session.** `sessionId` is a request
  field, so a new session is structurally a new `GetKey`. Long-lived keys thus
  rotate with **session granularity and no push mechanism**: the issuer swaps
  what it hands out, and daemons converge as sessions turn over.
- **Expiring keys just lapse**; the refresh loop replaces them in place while a
  session runs.
- **Long-lived keys are revoked, not expired.** The daemon calls `RevokeKey` when
  a session holding one ends. `RevokeKey` is idempotent — unknown and
  already-revoked ids succeed, because the caller wants "ensure it is dead", not
  an existence probe. The contract states intent: the server no longer issues or
  renews the key and makes its best effort to kill it upstream; the enforcement
  mechanism (deny rule, upstream deactivation, secret rotation) is the
  implementation's.
- Killing an **in-flight** session's credential immediately is a data-path
  concern of the implementation, out of this contract's scope.

## 6. Failure semantics

Errors are machine-readable (`KeyServerErrorBody`), and the daemon's obligation
is to keep them attributable — a suspended org must surface as "organization
suspended", never as a generic internal error:

| Code            | HTTP | Daemon behavior                                                        |
| --------------- | ---- | ---------------------------------------------------------------------- |
| `org_suspended` | 403  | Surface as an org-level, user-visible condition; do not retry blindly. |
| `quota_denied`  | 403  | Surface as a limit condition with the issuer's message.                |
| `unauthorized`  | 401  | Credential problem between daemon and key server; operator-facing.     |
| `unavailable`   | 503  | Enter the degradation window below; retry with backoff.                |

**Degradation window.** An issued credential stays valid until its `expiresAt`
even when the key server is unreachable — the TTL is the contractual answer to
"how long do sessions keep working through an issuer outage", and implementations
size it as the tradeoff between revocation latency and outage tolerance. Only
starting or refreshing past the horizon needs the server back.

## 7. What this replaces, and what it does not

The seam supersedes the older direction where the Control Plane would sign
per-session gateway tokens and publish JWKS: credential issuance now lives
entirely behind this contract, and the CP neither mints nor verifies provider
credentials. The static-key path is not deprecated by any of this — it is layer 2
of the same precedence chain, and remains the whole story for deployments that
never configure a key-server address.
