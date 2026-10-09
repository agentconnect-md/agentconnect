# AgentConnect threat model

Notes for an automated auditor. The authoritative design record is `/src/docs/designs/` (start with
`architecture.md`, index in `/src/docs/README.md`); the disclosure policy is `/src/SECURITY.md`. Where this
file and the design record disagree, the design record wins.

## What this project does

AgentConnect connects chat platforms (Slack, Telegram, Discord, Lark/Feishu, Google Chat), code hosts
(GitHub, GitLab, Gitea), Linear, generic webhooks and a browser webchat to AI coding agents (Claude,
Codex and other ACP runtimes). An organization enrols its own bots and apps, picks which agents answer
where, and the agents run code on machines the organization chooses. It is a pnpm monorepo under
`/src/packages/`; every package is TypeScript on Node 24.

## Components

| Package                                                                         | Role                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `control-plane` (CP)                                                            | Fastify + Prisma/Postgres. Orchestration, registry, human auth, the REST/SSE surface behind the console (`src/http/`), the daemon and relay WebSocket endpoints (`src/ws/`).                                   |
| `daemon`                                                                        | The execution unit. Owns direct platform connections, routing, provider egress, workspaces, and the agent runtime over ACP; dials out to the CP over one WebSocket.                                            |
| `relay`                                                                         | Optional public ingress. Terminates Slack/Feishu/Google Chat/Linear HTTP callbacks, GitHub/GitLab/Gitea webhooks, generic webhooks, the MCP proxy, and webchat; forwards to the owning daemon. Stores nothing. |
| `setup`                                                                         | Loopback-bound Setup Server for self-hosting: Logto and provider-app administration against the deployment database.                                                                                           |
| `web`                                                                           | Next.js console. A pure client of the CP's REST surface; no server-side secrets.                                                                                                                               |
| `protocol`, `message`, `connection`                                             | The wire contract (zod frames, org-scoping rules in `frame-scope.ts`), pure platform normalization, and the WS primitives shared by the three services.                                                        |
| `cli`, `k8s-client`, `observability`, `memory-plugin-mem0`, `activation-policy` | The `agentconnect` bin, the bare-REST Kubernetes client the pool driver uses, OTel bootstrap with span-name hygiene, the Mem0 MCP wrapper, trigger-policy evaluation.                                          |
| `daemon/src/shim/`                                                              | The in-sandbox shim: the half-trusted process inside a sandbox pod or VM that executes what the daemon asks over a bound channel (`cluster-spawn-and-shim.md`).                                                |

The ACP adapters (`claude-agent-acp`, `codex-acp`) and the model runtimes are separate projects.

## Deployment modes and the execution trust model (`architecture.md` sections 3.1 and 9)

- **Self-hosted daemon**: the organization runs the daemon on its own machine under its own OS account.
  The person who controls that host is the _daemon operator_. An agent that runs with the `host`
  strategy (no sandbox) is **operator-trusted code** with the daemon account's ambient authority.
  That is by design; the operator chooses it per agent, or forbids it with `--require-sandbox`.
- **Managed daemon pool** (Kubernetes): no operator sits at the host, no agent is trusted, and the
  sandbox pod is the boundary. The daemon authenticates with a projected ServiceAccount token, the shim
  proves its pod through TokenReview, and no org-scoped credential ever lives in the sandbox.

Sandbox tiers, in increasing strength (`session-executors.md` section 5, `daemon-sandbox-backends.md`):

| Strategy       | Boundary                      | Intended for                                                                                               |
| -------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `host`         | none                          | trusted work only                                                                                          |
| `srt`          | process (bubblewrap, seccomp) | trusted work; "contains a runtime's mistakes, not a determined adversary"; shares the host kernel and user |
| `microsandbox` | VM                            | untrusted input: public PRs/issues, external channels, public webhooks                                     |
| pool pod       | Kubernetes pod + the shim     | everything in the managed pool                                                                             |

A session that acts on input the operator does not control is untrusted _because of that input_,
whatever authorized its trigger, and is meant to run in `microsandbox` or a pool pod.

## Trust boundaries and where untrusted input enters

1. **Relay HTTP ingress** (`relay/src/platforms/*`, `relay/src/hooks/`): unauthenticated internet.
   Slack HMAC over raw bytes with a replay window and timing-safe compare; Feishu verification token /
   encrypt key; GitHub `X-Hub-Signature-256` is mandatory; GitLab uses Standard Webhooks signatures
   (`hooks/standard-webhooks.ts`); Gitea a hex HMAC header; the generic webhook an unguessable capability
   URL plus `X-AC-Signature` (`hooks/signature.ts`); `hooks/rate-limit.ts` throttles. A verified event is
   demuxed to the owning bot and forwarded as `rd/*` frames to the owning daemon.
2. **Webchat and the agent chat API** (`relay/src/relay-browser-server.ts`, `agent-chat-route.ts`):
   a browser holds a short-lived token minted by the CP only after its visibility check; the chat API
   is authenticated by personal/OAuth keys whose agent selection the CP enforces.
3. **The MCP proxy** (`relay/src/mcp`, `centralized-tool-management.md`): the relay injects upstream
   credentials while proxying; an upstream URL is an SSRF primitive, so egress must be validated.
4. **CP REST/SSE** (`control-plane/src/http/`): browser sessions (OIDC JWT via JWKS), personal API
   keys, OAuth access tokens, and the MCP surface. Pipeline: `humanAuth` -> `org-scope` (path org
   membership, key org binding, OAuth scope confinement) -> `authorization/policy.ts` (`can()`,
   `visibilityWhere`) -> handler. Routes marked `interactiveOnly` (key minting/revocation, org
   lifecycle, daemon provisioning, OAuth consent) refuse every non-interactive principal with 403.
5. **Daemon and relay WebSockets to the CP** (`control-plane/src/ws/`, `daemon-api-key-auth.md`,
   `daemon-cp-ws-protocol.md`): opaque bearer keys stored as `HMAC-SHA256(secret, API_KEY_PEPPER)`,
   bound to one daemon and one org; a daemon key cannot act as a user and vice versa. Every org-scoped
   frame carries `orgId` and both peers check it against the resource targeted (`SCOPE_DENIED`); epochs
   and `seq` fence stale senders. The CP never dials in.
6. **Direct platform connections on the daemon** (Slack Socket Mode, Telegram, Discord, Feishu long
   connection): message bodies, attachments (downloaded by the daemon with the bot's credentials, size
   bounded), mentions and reactions from anyone the platform lets into the channel.
7. **The agent itself**: model output, tool calls, child processes, MCP servers it is given, skills it
   installs, and every file in its workspace (including a checkout's `.git/config`). Inside a sandbox tier
   this is the adversary; under `host` it is operator-trusted (see above).
8. **The shim channel** (`daemon/src/shim/`): the pod side is half-trusted. `exec` takes argv only,
   path containment is re-checked on the shim side, the `read` channel walks descriptors with
   `O_NOFOLLOW`, and `ShimBindingRegistry.authorize` is the single predicate for credential, expiry,
   generation and per-operation grant.
9. **Operator-supplied uploads and config**: agent/org icon uploads (`sharp`, `@resvg/resvg-js`),
   Slack manifests, integration credentials entered in the console or Setup Server.

## Invariants worth attacking

- The CP stores **control-plane metadata only**: never platform message bodies, ACP `session/update`
  streams, or attachment bytes. Bounded BFF reads proxy daemon content without persisting it.
- **Org isolation** at the data layer (`org-scoped-data-layer.md`): every repository read is scoped;
  `*Unscoped` methods are for reconciliation and lint-exempted. Secrets at rest go through
  `SecretCipher` with the org asserted out of band (`per-org-secret-encryption.md`); a row from org A
  handed to code serving org B must fail to open, not decrypt silently.
- **Resource visibility** (`resource-visibility.md`, `session-visibility.md`): `org` vs `restricted`
  audiences on agents, daemons, crons, MCP providers, skill sources and decisions; an independent
  audience boundary on sessions and transcripts; owners see everything in their org; viewers never write.
- **Credentials never enter logs, telemetry, span names, error responses or transcripts**
  (`high-availability.md`, `observability` package). Plaintext keys are shown exactly once when minted.
- **Credential confinement**: the Slack signing secret never reaches a daemon; the Feishu app secret
  never reaches a relay; a daemon receives credentials only for what is placed on it; a sandboxed
  runtime sees a placeholder and the VM's TLS proxy substitutes the real provider key for allowed hosts
  only; the git credential helper in a pod is root-owned and dials a tunnel the daemon authorizes per
  grant.
- **Tenant fence** (`ingress-tenant-fence.md`): a delivery that provably names another tenant is refused.
- **Loop breaker** (`loop-breaker-design.md`): bot-to-bot and agent-to-agent chains must terminate.
- **Decisions and triggers** (`decisions.md`, `webhook-triggers-and-github-events.md`): who may summon
  an agent, maintainer gates on external PRs/issues, and the prompt boundary around untrusted event text.

## Out of scope (do not report)

- The **no-auth local mode**: with `OIDC_ISSUER` unset the CP injects a fixed owner principal. It is the
  loopback-only evaluation mode of the Compose stack; exposing it beyond loopback is operator error.
- The **Setup Server** reached off loopback, or a self-hosted deployment that disables TLS or
  otherwise departs from the documented configuration.
- Anything an **operator-trusted `host`-strategy agent** can do to its own daemon account, and `srt`
  sharing the host kernel and user: both are documented trust choices, not escapes.
- Findings that require an **already compromised daemon host, relay host, CP database or Vault**; the
  design states what each of those exposes.
- **Prompt injection on its own.** The model acting on text it reads is expected; the controls are the
  sandbox tier, tool permissions, decisions and the loop breaker. A finding must cross one of those.
- Placement and reconciliation reads being **unfiltered by visibility** (`resource-visibility.md` section 9),
  the public-by-design agent icon endpoint, and the two stated fail-open residuals of the tenant fence.
- Model provider behaviour, the ACP adapters, the runtime images, dependency advisories with no
  reachable path, and the Linux-only nature of the shim and `host` executor.
- `docs/`, `evals/`, `scripts/`, `charts/`, test fixtures and anything under `test/` are not entry points.

## Severity

- **Critical**: cross-organization read or write of agents, sessions, transcripts, secrets or
  credentials by an authenticated member of another org; unauthenticated bypass of `humanAuth`, the
  daemon/relay WS auth or `org-scope`; a forged platform event or webhook accepted without a valid
  signature and able to start an agent turn; escape from `microsandbox` or a pool pod onto the daemon
  host or into another session; a shim binding that reaches another launch's credentials; disclosure
  of stored integration credentials or API key plaintext to a non-owner; SSRF that makes the relay send
  injected upstream credentials to an attacker host.
- **High**: in-org privilege escalation (viewer writes, a restricted resource or session visible outside
  its audience, `interactiveOnly` reached by a key or token, a personal key minting keys); path traversal
  past a workspace root through the console workspace browser or the shim `read` channel; credential
  values in logs, telemetry, error bodies or transcripts; cross-tenant attribution the fence should have
  refused; webhook replay outside the window; a single request that crashes the CP or a relay.
- **Medium**: `srt` confinement gaps; metadata or existence oracles across a visibility boundary;
  resource exhaustion that needs sustained traffic; loop or amplification the breaker misses; issues
  that need a non-default but supported configuration.
- **Low**: hardening suggestions, verbose errors without secrets, issues confined to the no-auth
  local mode or to development tooling.

## How to exercise it

Everything is built in place under `/src` (`packages/*/dist`, the Prisma client at
`packages/control-plane/src/generated/prisma`). The suites run offline; keep workers low:

```sh
cd /src
pnpm --filter @agentconnect.md/protocol test:unit --maxWorkers=2
pnpm --filter @agentconnect.md/relay test:unit --maxWorkers=2
pnpm --filter @agentconnect.md/control-plane test:unit --maxWorkers=2             # src/**/*.test.ts, no database
pnpm --filter @agentconnect.md/daemon test:unit --maxWorkers=2                    # ~560 files; sandbox suites need bwrap, socat, rg
pnpm --filter @agentconnect.md/daemon exec vitest run test/shim-handshake.test.ts # one file
```

`control-plane test:int` needs Docker (Testcontainers) and will not run here. The image carries a
Debian PostgreSQL instead, so the CP itself can be started offline: start the cluster as root
(`service postgresql start`), create a database, then
`DATABASE_URL=... pnpm --filter @agentconnect.md/control-plane exec prisma migrate deploy` and
`API_KEY_PEPPER=<32+ chars> DATABASE_URL=... node packages/control-plane/dist/index.js` (no-auth mode,
REST on :8080, OpenAPI at `/api/v1/openapi.json`). The relay starts from `packages/relay/dist/index.js`
and the daemon from `packages/daemon/dist/index.js`; both expect a CP to dial. Pure ingress logic
(signature verification, demux, frame scoping, authorization policy) is unit-testable without any of
them, and that is where most of the boundaries above live.

## Reports and patches

A report names the component, the boundary crossed, the principal the attacker holds, and a runnable
reproducer against this image: a vitest case in the package's own `test/` or `src/*.test.ts` layout,
or a script under `/src`. Patches should be small, against `main`, with that test, and must not weaken
the invariants above to make a test pass. Please send findings through the enrolment's private email
only; do not open public issues or pull requests for vulnerabilities.
