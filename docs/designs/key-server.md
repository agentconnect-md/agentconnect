# Key Server — Dynamic Provider-Credential Issuance

**Status:** implemented by the cloud daemon (`--k8s`) and declared by
`@agentconnect.md/protocol` `key-server.ts`. This document records the semantics that
the schema cannot carry.

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

| Operation   | Route                 | Body → Response                                                                                                       |
| ----------- | --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `IssueKey`  | `POST /v1/issue-key`  | `{orgId, agentId, sessionId, provider, ttlSeconds?}` → `{keyId, key, baseUrl?, expiresInSeconds?, refreshInSeconds?}` |
| `RevokeKey` | `POST /v1/revoke-key` | `{keyId}` → `{}`                                                                                                      |

**Caller authentication rides the transport, never the body.** Configured with a
token source, the daemon sends `Authorization: Bearer <token>`; configured with
none, the request carries no auth header at all — which is the shape for a key
server the daemon already reaches inside one trust boundary. To the daemon the
token is an opaque string from a configured source: a file it re-reads per
request, so a credential something else rotates underneath it stays current, or
an inline config value. It parses nothing, asserts nothing about what the token
means, and holds no verification logic.

`daemonId` is deliberately not a body field: a client-asserted identity would be
untrusted input, and a server that can verify the bearer at all can derive the
caller from it. `orgId` IS in the body, and a server that resolves an
organization from the token should cross-check the two.

**What the token is, and what a server does with it, are outside this contract.**
Which credential the daemon is given, what proves it, and what the server must
hold to check it are decided together by the key server's own design and the
deployment that installs both. This document stops at the header.

`provider` names the API dialect the credential must speak (`anthropic` /
`openai`) and selects which `(key, baseUrl)` pair comes back. There is
deliberately **no `model` parameter**: per-model usage attribution belongs to
whatever observes actual requests (a gateway data path, or the runtime's own usage
reports), and a spawn-time hint would invite implementations to treat it as truth
the daemon does not have — a runtime switches models mid-session.

### 2.1 Daemon configuration

Cloud daemons accept `--key-server <https-url>` and
`--key-server-token-path <path>`. The equivalent deployment environment names are
`KEY_SERVER` and `KEY_SERVER_TOKEN_PATH`; explicit CLI values win. A token path
without a server is rejected, and these options are rejected outside `--k8s`.

The bearer file is read for every IssueKey and RevokeKey request. The kubelet or
another credential agent can therefore rotate the file without restarting the daemon.
The token is never copied into an agent environment.

## 3. Validity: durations, and the narrowing rule

**Both directions state validity as a duration in seconds, never as an instant.**
An absolute expiry is only meaningful on the clock that produced it: the server
stamps it after the request lands, so a caller subtracting its own request time
measures the round trip as if it were granted validity, and any skew between the
two clocks lands directly in the result. Durations remove both, and the narrowing
rule below becomes arithmetic on one scale rather than a comparison between two
clocks.

The server measures its durations from the instant it issued the credential.
**The daemon, which cannot observe that instant, anchors them at its own
request-send time** — read from a monotonic clock, so a local time adjustment
cannot move a deadline already in flight. The request necessarily left at or
before issuance, so every deadline derived this way is at or before the real one:
the daemon expires and refreshes early by the request's flight time plus whatever
the server spent, and never late. Anchoring at response receipt would invert
this, putting the daemon's deadline a full round trip _past_ the issuer's and
overstating the degradation window by the same amount.

`ttlSeconds` is the caller's desired validity; absent means it asks for a
**long-lived key** it will manage explicitly. The server may only narrow:

- request with `ttlSeconds` ⇒ response MUST carry `expiresInSeconds`, at most the
  requested value (`keyGrantViolation` in the contract makes this executable, and
  reads no clock to do it);
- request without `ttlSeconds` ⇒ response MAY omit `expiresInSeconds`; omitting it
  means no refresh loop runs and the degradation window below does not apply;
- `refreshInSeconds` is a renew-from hint on the same scale, legal only alongside
  `expiresInSeconds` and strictly less than it. Daemons renew inside that window
  instead of inventing their own margin.

## 4. Injection: one precedence chain, pairs never split

The response pair is atomic with respect to injection — a dynamic key must never
be combined with a static base URL or vice versa (a gateway credential aimed at a
public endpoint 401s; a real key aimed at a gateway bypasses whatever the
deployment put there). The daemon resolves the pair for a spawn top-down and takes
the first layer that yields a key, whole:

1. `IssueKey` response — when a key-server address is configured;
2. the daemon's static config pair — when no key-server is configured;
3. the runtime's default public endpoint with whatever credential the runtime
   environment already carries.

Within a layer, an absent `baseUrl` falls through to the next layer's URL — that
is the one sanctioned mix, so a key-server that only rotates keys and fronts no
gateway needs no URL opinion. A present one must be `http(s)`, since it becomes a
runtime's API base; plain `http` is legal and is the normal choice for a loopback
or in-pod gateway.

The cloud daemon's static pair is `MODEL_TOKEN` plus optional `MODEL_BASE_URL`.
`MODEL_BASE_URL` must be an HTTP(S) URL. The pair is translated at runtime launch:

| Runtime  | Token                                                                                    | Base URL                                                                                                                             |
| -------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Claude   | `ANTHROPIC_AUTH_TOKEN`                                                                   | `ANTHROPIC_BASE_URL`                                                                                                                 |
| Codex    | `OPENAI_API_KEY`                                                                         | `CODEX_CONFIG` → `model_provider = "openai"` and `model_providers.openai.base_url`; `OPENAI_BASE_URL` is also set for older adapters |
| OpenCode | `OPENCODE_CONFIG_CONTENT` → selected provider `options.apiKey` using `{env:MODEL_TOKEN}` | selected provider `options.baseURL`                                                                                                  |

Dynamic grants use the same translation and override the static token. If IssueKey
omits `baseUrl`, only the static `MODEL_BASE_URL` is inherited. With no key server,
the static pair wins; with neither, the runtime's existing provider configuration is
left unchanged.

One logical AgentConnect session owns one ACP host when key-server mode is active.
Provider credentials are process-level settings, so sharing a runtime would let
concurrent sessions use whichever key was written last. Internal model jobs use their
own opaque session identities and revoke their grants when their one-off host stops.
OpenCode derives the credential provider from the effective session model. A started
host is authoritative for its whole working life: while its session still has live SDK
work, a model switch to another provider is recorded as the sticky session override but
never pushed to the running process, whose options only ever received the key and base
URL of the provider it was started for. The next start after the work settles reads that
override, issues for the new provider, and rebinds. Without a key server the shared
static-credential host has no per-session start to rebind at, so it refuses a
cross-provider selection outright instead of storing one that could never be honoured.

## 5. Caching, rotation, and revocation

- **Cache within a session, re-fetch per session.** `sessionId` is a request
  field, so a new session is structurally a new `IssueKey`. Long-lived keys thus
  rotate with **session granularity and no push mechanism**: the issuer swaps
  what it hands out, and daemons converge as sessions turn over.
- **Expiring keys lapse.** The daemon replaces one once its refresh hint has passed,
  before the session's next activation; if refresh fails before expiry, the current
  host remains usable for the rest of its granted window. Live SDK background work
  pins the host to its start-time credential: rotation never terminates work in flight,
  and past expiry the pinned host keeps running on the lapsed grant until the session
  becomes quiescent — a request the issuer has stopped honouring fails upstream, which
  is strictly better than the daemon killing background work to enforce the boundary.
- **A host is never handed out to a released session.** Teardown joins an in-progress
  start rather than observing an entry that has no host yet, so a host born after its
  release is stopped instead of leaking untracked.
- **Long-lived keys are revoked, not expired.** The daemon calls `RevokeKey` when
  a session holding one ends. `RevokeKey` is idempotent — unknown and
  already-revoked ids succeed, because the caller wants "ensure it is dead", not
  an existence probe. The contract states intent: the server stops issuing or
  renewing under that `keyId` and makes its best effort to kill it upstream; the
  enforcement mechanism (deny rule, upstream deactivation, secret rotation) is
  the implementation's.
- **`keyId` names the issuance, not the underlying credential**, and that is what
  makes the rule above safe to apply unconditionally. A server may answer two
  issuances with the same secret — a vault fronting one rotating provider key
  does exactly that — and only it knows whether a given `keyId` has other holders.
  So the daemon always revokes what it was issued, and a server for which that
  would kill a shared credential treats the call as a no-op. The alternative,
  making the daemon decide, requires it to know something the seam deliberately
  hides from it.
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

**Degradation window.** An issued credential stays usable for its granted
`expiresInSeconds` from the anchor of §3 — never longer, since that anchor
precedes issuance — even when the key server is unreachable. The TTL is thus the
contractual answer to "how long does a session keep working through an issuer
outage", and an implementation sizes it as its own tradeoff between revocation
latency and outage tolerance. Only starting or refreshing past that horizon needs
the server back.

## 7. What this replaces, and what it does not

The seam supersedes the older direction where the Control Plane would sign
per-session gateway tokens and publish JWKS: credential issuance now lives
entirely behind this contract, and the CP neither mints nor verifies provider
credentials. The static-key path is not deprecated by any of this — it is layer 2
of the same precedence chain, and remains the whole story for deployments that
never configure a key-server address.
