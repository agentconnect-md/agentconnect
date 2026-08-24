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
daemon cannot tell the difference, by design: it receives an opaque key and
injects it exactly like the static token it replaces.

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

| Operation   | Route                 | Body → Response                                                                                             |
| ----------- | --------------------- | ----------------------------------------------------------------------------------------------------------- |
| `IssueKey`  | `POST /v1/issue-key`  | `{orgId, agentId, sessionId, provider, ttlSeconds?}` → `{keyId, key, expiresInSeconds?, refreshInSeconds?}` |
| `RevokeKey` | `POST /v1/revoke-key` | `{keyId}` → `{}`                                                                                            |

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
`openai` / `deepseek`) and selects which key comes back. There is
deliberately **no `model` parameter**: per-model usage attribution belongs to
whatever observes actual requests (a gateway data path, or the runtime's own usage
reports), and a spawn-time hint would invite implementations to treat it as truth
the daemon does not have — a runtime switches models mid-session.

### 2.1 Daemon configuration

Cloud daemons accept `--key-server <url>` — **http or https, the deployment's choice**: the bearer
is a projected ServiceAccount token, and a daemon that already reaches its control plane over an
in-cluster `ws://` gains nothing from one hop being stricter than the boundary it sits in. A
deployment that terminates TLS on this hop simply configures an https address. Beside it they accept
`--key-server-token-path <path>`. The equivalent deployment environment names are
`KEY_SERVER` and `KEY_SERVER_TOKEN_PATH`; explicit CLI values win. A token path
without a server does nothing and says so, as does a server without a token — that one sends every
request with no `Authorization` header at all, which a server that reviews its callers refuses. Both
are warnings rather than refusals: a key server may be configured to trust its callers by network
position, and that is its operator's call to make. A key server itself does require `--k8s`, because
the credential it mints is only usable with the `*_MODEL_BASE_URL` pair that aims it at this
install's gateway, and that pair is cloud-mode configuration.

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

## 4. Injection: the key is issued, the base URL is deployed

Key and base URL answer to different owners, so they come from different places and
neither completes the other:

- **the key** is per-session identity, and an `IssueKey` response is its only source
  when a key-server address is configured; with none, the daemon's static token; with
  neither, whatever credential the runtime environment already carries.
- **the base URL** is deployment topology — which gateway this install's runtimes talk
  to — so it always comes from the daemon's own configuration, key server or not. The
  contract defines no `baseUrl`, and an issuer that sends one is stripped rather than
  rejected (responses parse tolerantly).

An issuer naming the address would be restating a fact it does not own: the address is
the same for every session the install ever runs, and it is already written down where
the gateway is deployed. Two copies of it invite disagreement, and the disagreement
surfaces as a runtime aimed somewhere the deployment never put a gateway.

What remains beneath both is the runtime's own environment, including the pod's
`AC_*_BASE_URL` floor the shim fills in: a daemon with no base URL configured for a
runtime leaves that environment as it found it. A configured base URL must be
`http(s)`, since it becomes a runtime's API base; plain `http` is legal and is the
normal choice for a loopback or in-pod gateway.

The cloud daemon's static pair is `MODEL_TOKEN` plus optional `MODEL_BASE_URL`, with a
per-runtime pair that replaces it whole: `ANTHROPIC_MODEL_TOKEN`/`ANTHROPIC_MODEL_BASE_URL`
for Claude, `OPENAI_MODEL_*` for Codex, `DEEPSEEK_MODEL_*` for the DeepSeek Harness.
OpenCode has no pair of its own — it picks a provider per model and takes the shared one.
`*_MODEL_TOKEN` names an opaque deployment credential, not a header choice: despite the
word "token" it is unrelated to `ANTHROPIC_AUTH_TOKEN`, and Claude's injection slot is
`ANTHROPIC_API_KEY` (see the table below).

One deployment gateway is still one address; the runtimes just do not agree on where their
base ends. Claude Code appends `/v1/messages` to its base, while Codex appends `/responses`
and OpenCode's providers append `/messages`, so the same gateway is `https://gw` for one and
`https://gw/v1` for the others. The daemon injects each base verbatim and never derives a
path: the gateway's own layout is the deployment's to know, so composing these variables from
one address belongs where that layout is configured, not in a runtime guess. Every base URL
must be an HTTP(S) URL. Each pair is translated at runtime launch:

| Runtime  | Token                                                                                    | Base URL                                                                                                                             |
| -------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Claude   | `ANTHROPIC_API_KEY` (`ANTHROPIC_AUTH_TOKEN` is cleared — one credential per launch)      | `ANTHROPIC_BASE_URL`                                                                                                                 |
| Codex    | `OPENAI_API_KEY`                                                                         | `CODEX_CONFIG` → `model_provider = "openai"` and `model_providers.openai.base_url`; `OPENAI_BASE_URL` is also set for older adapters |
| OpenCode | `OPENCODE_CONFIG_CONTENT` → selected provider `options.apiKey` using `{env:MODEL_TOKEN}` | selected provider `options.baseURL`                                                                                                  |
| DeepSeek | `DEEPSEEK_API_KEY`                                                                       | `DEEPSEEK_BASE_URL`                                                                                                                  |

Dynamic grants use the same translation for their key, and take their base URL from
these same variables — a key server changes where the token comes from, never where the
runtime points. With neither a key server nor a static token, the runtime's existing
provider configuration is left unchanged.

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
