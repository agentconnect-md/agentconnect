# Webchat-Scoped Preset Agent MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give private webchat sessions on the built-in `agentconnect` preset the existing AgentConnect read/write MCP catalog, acting with the conversation owner's live authority and isolated from every sibling ACP session.

**Architecture:** Deliver the design in five testable slices behind a disabled-by-default control-plane rollout gate: wire contracts, Linux isolation foundations, control-plane delegation/assertion authority, relay/daemon brokerage, then lifecycle and end-to-end enablement. The relay carries only an opaque delegation reference; a conversation-private daemon broker hashes exact MCP request bytes, mints a one-time assertion over the authenticated daemon WebSocket, and calls the standard CP MCP route. Each entitled conversation uses its own bwrap PID/mount-isolated ACP host and private socket mount; delegated state never enters the shared `McpControlServer`.

**Tech Stack:** TypeScript, zod, Fastify, Prisma/PostgreSQL, Node `AsyncLocalStorage`, Unix-domain sockets, Linux bubblewrap (`bwrap`), ACP, MCP Streamable HTTP, Vitest, Testcontainers, pnpm 11.

---

## Scope and delivery slices

The approved design spans four packages and several independent security boundaries. Implement it as these mergeable, feature-disabled slices:

1. Protocol and Linux isolation contracts.
2. CP delegation, invocation ledger, assertion authentication, and recovery.
3. Relay propagation and daemon private broker.
4. Dedicated conversation host lifecycle and generation replacement.
5. Capability-gated enablement, observability, and two-user end-to-end proof.

`session-visibility.md` is already implemented on `main` by PR #241; do not reimplement it. Preserve the existing default that webchat sessions are `private` with `ownerIdentity = user:<WebchatConversation.userId>`.

## File map

### Shared protocol

- Modify `packages/protocol/src/consts.ts`: export `DELEGATED_MCP_ASSERTION_FEATURE`.
- Create `packages/protocol/src/frames/delegated-mcp.ts`: delegation reference, mint request/reply, and revoke request/reply schemas.
- Modify `packages/protocol/src/frames/relay-cp.ts`: optional delegation on `RcVerifyResult`.
- Modify `packages/protocol/src/frames/relay-daemon.ts`: optional delegation on `RdMsgWebchat`.
- Modify `packages/protocol/src/frame.ts` and `packages/protocol/src/index.ts`: register/export new daemon↔CP frames.
- Modify `packages/protocol/src/frames/{webchat,relay-cp,relay-daemon}.test.ts` and create `packages/protocol/src/frames/delegated-mcp.test.ts`: compatibility and strict validation.

### Control plane

- Modify `packages/control-plane/prisma/schema.prisma` and add one timestamped migration: durable delegation generation, delegations, invocation ledger, indexes, and relations.
- Modify `packages/control-plane/src/persistence/ports.ts` and `index.ts`: domain-facing ports.
- Create `packages/control-plane/src/persistence/repositories/webchat-mcp-delegation.repo.ts`: row-locked establish/revoke operations.
- Create `packages/control-plane/src/persistence/repositories/mcp-invocation.repo.ts`: mint/claim/complete/reap compare-and-set transitions.
- Create `packages/control-plane/src/registry/invocationAssertion.ts`: domain-separated assertion generation and peppered hashing.
- Create `packages/control-plane/src/registry/webchatMcpDelegationService.ts`: entitlement establishment, live authorization, mint, and revoke policy.
- Create `packages/control-plane/src/http/mcp/internal-invocation-auth.ts`: async-local nested request authorization with single-use method/path nonces.
- Create `packages/control-plane/src/http/mcp/invocation-authenticator.ts`: route-only assertion claim adapter.
- Modify `packages/control-plane/src/http/plugins/auth.ts`: accept only a valid in-process nonce as an alternate nested-request identity.
- Refactor `packages/control-plane/src/http/mcp/routes.ts`: route-specific auth, exact-byte claim, cached-response replay, delegated limits/audit, 120-second ambiguous timeout, and host-agent write denial.
- Create `packages/control-plane/src/ws/handlers/{mcp-invocation-mint,webchat-mcp-delegation-revoke}.ts`: authenticated-daemon request handlers.
- Modify `packages/control-plane/src/ws/{deps,handlers/index}.ts`, `src/container.ts`, `src/http/deps.ts`, and `src/config/env.ts`: composition and disabled-by-default rollout gate.
- Create `packages/control-plane/src/orchestrator/mcpInvocationReaper.ts`: issued/running/terminal cleanup using the same timeout constant as HTTP dispatch.
- Modify `packages/control-plane/src/persistence/repositories/agent.repo.ts`: revoke active delegations in the same placement-change transaction.
- Add focused unit tests beside each module and integration tests under `packages/control-plane/test/integration/`.

### Relay

- Modify `packages/relay/src/relay-browser-server.ts`: retain only the CP-returned delegation reference in the authenticated browser connection.
- Modify `packages/relay/src/relay-browser-connection.ts`: copy that immutable reference to every `RdMsgWebchat`.
- Extend `packages/relay/src/relay-browser-{server,connection}.test.ts`: browser input cannot inject/override it and every operation propagates it.

### Daemon

- Modify `packages/daemon/src/acp/sandbox.ts`: explicit delegated-cell capability probe and private mount policy.
- Extend `packages/daemon/src/acp/acp-host.ts`: accept a trusted launch wrapper/mount description without exposing it to ACP/model input.
- Create `packages/daemon/src/acp/delegated-webchat-host-manager.ts`: one host and private runtime home per entitled logical conversation.
- Create `packages/daemon/src/mcp/session-mcp-broker.ts`: immutable cell bindings, private listeners/tokens, exact-byte HTTP forwarding, assertion minting, and generation fencing.
- Modify `packages/daemon/src/cp/client.ts`: typed mint/revoke request methods.
- Modify `packages/daemon/src/daemon.ts`: capability emission, trusted-envelope admission, per-conversation host selection, generation drain/replace, close/expiry/detach cleanup, and shutdown.
- Add `packages/daemon/test/{delegated-mcp-isolation,delegated-webchat-host-manager,session-mcp-broker}.test.ts` and extend `sandbox.test.ts`, `daemon-webchat.test.ts`, `cp/transport.test.ts`, and the real-process matrix only where kernel behavior must be proven.

## Constants and wire shapes

Use these values consistently:

```ts
export const DELEGATED_MCP_ASSERTION_FEATURE = 'delegated_mcp_assertion_v1'
export const MCP_ASSERTION_CLAIM_TTL_MS = 30_000
export const MCP_INVOCATION_EXECUTION_TIMEOUT_MS = 120_000
export const MCP_INVOCATION_CACHE_TTL_MS = 15 * 60_000
export const MCP_INVOCATION_MAX_RESPONSE_BYTES = 256 * 1024
export const WEBCHAT_MCP_DELEGATION_TTL_MS = 12 * 60 * 60_000
```

The public protocol schema is:

```ts
export const WebchatMcpDelegationReference = z
  .object({
    id: z.string().uuid(),
    generation: z.number().int().positive(),
    expiresAt: z.string().datetime()
  })
  .strict()

export const McpInvocationMint = z
  .object({
    delegationId: z.string().uuid(),
    generation: z.number().int().positive(),
    agentId: z.string().uuid(),
    conversationId: z.string().uuid(),
    invocationId: z.string().uuid(),
    requestHash: z.string().regex(/^[0-9a-f]{64}$/),
    method: z.enum(['tools/list', 'tools/call']),
    toolName: z.string().min(1).optional()
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.method === 'tools/call' && !v.toolName) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['toolName'], message: 'toolName is required for tools/call' })
    }
    if (v.method === 'tools/list' && v.toolName !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['toolName'], message: 'toolName is not valid for tools/list' })
    }
  })

export const McpInvocationMinted = z
  .object({
    invocationId: z.string().uuid(),
    assertion: z.string().min(1),
    expiresAt: z.string().datetime()
  })
  .strict()

export const WebchatMcpDelegationRevoke = z
  .object({
    delegationId: z.string().uuid(),
    generation: z.number().int().positive(),
    reason: z.enum(['session_closed', 'session_expired', 'agent_detached'])
  })
  .strict()
```

### Task 1: Add optional protocol contracts

**Files:**

- Create: `packages/protocol/src/frames/delegated-mcp.ts`
- Create: `packages/protocol/src/frames/delegated-mcp.test.ts`
- Modify: `packages/protocol/src/consts.ts`
- Modify: `packages/protocol/src/frames/relay-cp.ts`
- Modify: `packages/protocol/src/frames/relay-daemon.ts`
- Modify: `packages/protocol/src/frames/relay-cp.test.ts`
- Modify: `packages/protocol/src/frames/relay-daemon.test.ts`
- Modify: `packages/protocol/src/frame.ts`
- Modify: `packages/protocol/src/index.ts`

- [ ] **Step 1: Write failing schema tests**

Add legacy/new round-trip cases, strict UUID/hash/generation validation, the `tools/call`/`toolName` cross-field rule, revoke reason enumeration, and assertions that neither mint payload carries `daemonId`.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```bash
pnpm --filter @agentconnect.md/protocol test -- src/frames/delegated-mcp.test.ts src/frames/relay-cp.test.ts src/frames/relay-daemon.test.ts
```

Expected: FAIL because the new schemas/optional fields do not exist.

- [ ] **Step 3: Implement the schemas and frame registration**

Register `mcp/invocation/mint`, `mcp/invocation/minted`, `webchat/mcp-delegation/revoke`, and `webchat/mcp-delegation/revoked` in `FRAME_SCHEMAS`. Add `delegation: WebchatMcpDelegationReference.optional()` only to CP verification output and trusted relay→daemon webchat delivery.

- [ ] **Step 4: Run protocol tests and typecheck**

Run:

```bash
pnpm --filter @agentconnect.md/protocol test
pnpm --filter @agentconnect.md/protocol typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol
git commit -m "feat(protocol): add webchat MCP delegation frames"
```

### Task 2: Prove the Linux isolation capability without advertising it

**Files:**

- Modify: `packages/daemon/src/acp/sandbox.ts`
- Modify: `packages/daemon/test/sandbox.test.ts`
- Create: `packages/daemon/test/delegated-mcp-isolation.test.ts`

- [ ] **Step 1: Write failing capability-probe tests**

Test that delegated isolation is false for macOS `sandbox-exec`, missing/failed bwrap, and `security.requireSandbox=false`; true only for a successful Linux bwrap probe with daemon-wide enforcement. Test generated bwrap arguments contain a PID namespace, fresh `/proc`, and a tmpfs masking the common admin-socket source root for **every** bwrap ACP host. An entitled cell may then add exactly one later cell-private bind; an ordinary bwrap host gets no bind-back and sees only the empty tmpfs.

- [ ] **Step 2: Run the focused tests and confirm RED**

```bash
pnpm --filter @agentconnect.md/daemon test -- test/sandbox.test.ts test/delegated-mcp-isolation.test.ts
```

Expected: FAIL because delegated isolation admission/mount policy is absent.

- [ ] **Step 3: Implement focused isolation primitives**

Add pure functions such as:

```ts
export interface DelegatedCellMount {
  maskedRoot: string
  sourceDir: string
  targetDir: string
}

export function supportsDelegatedMcpIsolation(input: {
  platform: NodeJS.Platform
  mechanism?: SandboxMechanism
  requireSandbox: boolean
  bwrapProbePassed: boolean
}): boolean

export function delegatedCellSandboxWrap(
  cmd: string,
  args: string[],
  baseWritable: string[],
  mount: DelegatedCellMount
): { cmd: string; args: string[] }
```

Reject non-descendant/symlink-escaping mount sources. Extend ordinary `sandboxWrap()` with a trusted `maskedReadRoots` input so every bwrap host masks the broker source root; keep all unrelated write-confinement behavior unchanged. The capability must remain false until the daemon can pass that mask to every untrusted ACP host it starts.

- [ ] **Step 4: Run daemon sandbox tests**

```bash
pnpm --filter @agentconnect.md/daemon test -- test/sandbox.test.ts test/delegated-mcp-isolation.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/acp/sandbox.ts packages/daemon/test/sandbox.test.ts packages/daemon/test/delegated-mcp-isolation.test.ts
git commit -m "feat(daemon): add delegated MCP isolation probe"
```

### Task 3: Add durable delegation and invocation persistence

**Files:**

- Modify: `packages/control-plane/prisma/schema.prisma`
- Create: `packages/control-plane/prisma/migrations/<timestamp>_webchat_mcp_delegation/migration.sql`
- Modify: `packages/control-plane/src/persistence/ports.ts`
- Modify: `packages/control-plane/src/persistence/index.ts`
- Create: `packages/control-plane/src/persistence/repositories/webchat-mcp-delegation.repo.ts`
- Create: `packages/control-plane/src/persistence/repositories/mcp-invocation.repo.ts`
- Create: `packages/control-plane/test/repo/webchat-mcp-delegation.repo.test.ts`
- Create: `packages/control-plane/test/repo/mcp-invocation.repo.test.ts`

- [ ] **Step 1: Write failing repository integration tests**

Cover row-locked concurrent establishment reusing one generation, placement/expiry rotation, generation-fenced revoke, identical mint retry rotating only an `issued` assertion, invocation conflict, single-winner `issued → running`, terminal byte replay, late completion losing to `ambiguous`, and reap windows.

- [ ] **Step 2: Run the new tests and confirm RED**

```bash
pnpm --filter @agentconnect.md/control-plane test:int -- test/repo/webchat-mcp-delegation.repo.test.ts test/repo/mcp-invocation.repo.test.ts
```

Expected: FAIL because schema/models/repos are absent.

- [ ] **Step 3: Add schema and migration**

Add `delegationGeneration Int @default(0)` to `WebchatConversation`; add the exact `WebchatMcpDelegation`, `McpInvocation`, and `McpInvocationStatus` shapes from the design, including relations and indexes. Store only peppered `assertionHash`, never plaintext.

- [ ] **Step 4: Generate Prisma client**

```bash
pnpm --filter @agentconnect.md/control-plane prisma:generate
```

Expected: generated client includes `WebchatMcpDelegation`, `McpInvocation`, and `McpInvocationStatus`.

- [ ] **Step 5: Implement atomic repository methods**

Use transactions and `SELECT ... FOR UPDATE` for conversation establishment. Use conditional `updateMany` status predicates for every state transition; never implement claim or completion as a read-then-write pair.

- [ ] **Step 6: Run repository tests**

```bash
pnpm --filter @agentconnect.md/control-plane test:int -- test/repo/webchat-mcp-delegation.repo.test.ts test/repo/mcp-invocation.repo.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/control-plane/prisma packages/control-plane/src/generated/prisma packages/control-plane/src/persistence packages/control-plane/test/repo
git commit -m "feat(control-plane): persist webchat MCP authority"
```

### Task 4: Implement delegation entitlement and assertion minting

**Files:**

- Create: `packages/control-plane/src/registry/invocationAssertion.ts`
- Create: `packages/control-plane/src/registry/invocationAssertion.test.ts`
- Create: `packages/control-plane/src/registry/webchatMcpDelegationService.ts`
- Create: `packages/control-plane/src/registry/webchatMcpDelegationService.test.ts`
- Modify: `packages/control-plane/src/container.ts`

- [ ] **Step 1: Write failing codec tests**

Assert at least 192 bits of entropy, a distinct prefix, domain-separated peppered hash, stable verification hash, and no plaintext persistence/loggable return shape.

- [ ] **Step 2: Write the service truth-table tests**

Cover owner/org/agent mismatch, missing membership, agent visibility, non-preset, unplaced/offline/wrong daemon, missing capability, expired/revoked/stale generation, wrong agent/conversation, unknown method/tool, and identical/conflicting invocation retries. For unknown conversation/delegation, removed membership, and newly hidden agent, assert the same public error code/message/status and response shape; only internal metric reason labels may differ.

- [ ] **Step 3: Run unit tests and confirm RED**

```bash
pnpm --filter @agentconnect.md/control-plane test:unit -- src/registry/invocationAssertion.test.ts src/registry/webchatMcpDelegationService.test.ts
```

Expected: FAIL because the modules are absent.

- [ ] **Step 4: Implement the codec and service**

Resolve the actor only from the durable conversation row. Entitle only when `presetAgent.get(orgId, 'general').agentId === agentId`, current membership exists, `canView(agent, ctx)` passes, placement matches, and the placed daemon advertises `DELEGATED_MCP_ASSERTION_FEATURE`. Mint rechecks those facts and compares authenticated daemon, durable agent, durable conversation, generation, method, and curated tool name. Collapse every externally observable entitlement/membership/visibility/preset/binding denial to one generic `DELEGATION_DENIED` contract; preserve detailed reason codes only inside non-secret metrics.

- [ ] **Step 5: Run unit tests**

```bash
pnpm --filter @agentconnect.md/control-plane test:unit -- src/registry/invocationAssertion.test.ts src/registry/webchatMcpDelegationService.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/control-plane/src/registry packages/control-plane/src/container.ts
git commit -m "feat(control-plane): establish webchat MCP delegations"
```

### Task 5: Add route-only invocation assertion authentication

**Files:**

- Create: `packages/control-plane/src/http/mcp/invocation-authenticator.ts`
- Create: `packages/control-plane/src/http/mcp/invocation-authenticator.test.ts`
- Create: `packages/control-plane/src/http/mcp/internal-invocation-auth.ts`
- Create: `packages/control-plane/src/http/mcp/internal-invocation-auth.test.ts`
- Modify: `packages/control-plane/src/http/plugins/auth.ts`
- Modify: `packages/control-plane/src/http/plugins/auth.test.ts`
- Modify: `packages/control-plane/src/http/deps.ts`
- Modify: `packages/control-plane/src/container.ts`

- [ ] **Step 1: Write failing claim-state tests**

Test exact bearer hash, invocation header UUID, exact raw bytes, method/tool body agreement, 30-second initial claim, single CAS winner, `in_progress`, cached terminal bytes, `ambiguous`, and denial before MCP parsing when bytes differ. Assert unknown assertion, removed member, hidden agent, revoked delegation, stale generation, and placement mismatch are externally identical; no branch reveals which durable resource exists.

- [ ] **Step 2: Write failing async-local nonce tests**

Test independent parallel nonces, one-time consumption, method/path mismatch, external copied header with no async-local context, and no authority inheritance for unrelated injected work.

- [ ] **Step 3: Run tests and confirm RED**

```bash
pnpm --filter @agentconnect.md/control-plane test:unit -- src/http/mcp/invocation-authenticator.test.ts src/http/mcp/internal-invocation-auth.test.ts src/http/plugins/auth.test.ts
```

Expected: FAIL because both seams are absent.

- [ ] **Step 4: Implement `InternalInvocationAuth`**

Use `AsyncLocalStorage<InvocationContextState>`. `issue(method, path)` stores a random nonce bound to the normalized method/path; `authorizeInjectedRequest(req)` atomically deletes only an exact match and sets:

```ts
req.principal = { userId: context.userId }
req.apiKeyOrgId = context.orgId
req.apiKeyScopes = ['mcp:read', 'mcp:write']
req.delegatedInvocation = {
  invocationId: context.invocationId,
  delegationId: context.delegationId,
  agentId: context.agentId,
  conversationId: context.conversationId
}
```

Add this check at the start of the human-auth prehandler; a network caller has no async-local store and follows normal auth.

- [ ] **Step 5: Implement `InvocationAssertionAuthenticator`**

Return only `execute`, `completed`, `in_progress`, or `ambiguous` after successful lookup/validation. Return one internal `denied(reasonCode)` variant for all failures; the MCP adapter must render every such variant as the same generic status/body while metrics consume the stable internal reason. Do not expose raw/hash values. Revalidate live membership, visibility, preset relation, placement, delegation, method, and tool before claim.

- [ ] **Step 6: Run focused tests**

```bash
pnpm --filter @agentconnect.md/control-plane test:unit -- src/http/mcp/invocation-authenticator.test.ts src/http/mcp/internal-invocation-auth.test.ts src/http/plugins/auth.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/control-plane/src/http packages/control-plane/src/container.ts
git commit -m "feat(control-plane): authenticate one-time MCP assertions"
```

### Task 6: Execute delegated calls through the standard MCP endpoint

**Files:**

- Modify: `packages/control-plane/src/http/mcp/routes.ts`
- Create: `packages/control-plane/src/http/mcp/routes.delegated.test.ts`
- Modify: `packages/control-plane/src/http/mcp/tools.ts`
- Modify: `packages/control-plane/test/integration/mcp.route.test.ts`
- Create: `packages/control-plane/test/integration/mcp-delegated.route.test.ts`

- [ ] **Step 1: Write failing integration tests**

Submit a minted assertion to `/api/v1/mcp` and prove it acts as the conversation owner. Cover all roles, hidden-resource 404, assertion rejection on ordinary REST, copied internal header, host `updateAgent`/`deleteAgent` denial before REST dispatch, other-agent writes, confirmation gates, delegated rate key `(userId, delegationId)`, audit fields, exact cached replay, duplicate write single execution, in-progress response, and 120-second ambiguous timeout.

- [ ] **Step 2: Run the delegated integration test and confirm RED**

```bash
pnpm --filter @agentconnect.md/control-plane test:int -- test/integration/mcp-delegated.route.test.ts
```

Expected: FAIL because `/mcp` accepts only personal/OAuth keys.

- [ ] **Step 3: Refactor route authentication without changing existing clients**

Preserve personal/OAuth behavior. Recognize the assertion prefix only in the MCP plugin, require `X-AgentConnect-Invocation-Id`, and claim against the unmodified raw body bytes before parsing. Execute claimed calls inside `internalInvocationAuth.run(context, ...)`; nested `ctx.get/send` use fresh one-time nonces instead of forwarding the assertion.

- [ ] **Step 4: Add delegated safeguards and terminal persistence**

Before REST dispatch, deny host-targeting `updateAgent`/`deleteAgent`. Key rate limits by user+delegation. Extend the existing bounded audit shape with non-secret delegated identifiers and `principalType: 'webchat_assertion'`. Cache the exact final HTTP response bytes/status only if at most 256 KiB. If a definite handler result exceeds that cap, compare-and-set the invocation to `ambiguous` and return the may-have-taken-effect error; never return an uncached success that a retry could execute again. Compare-and-set `running → ambiguous` at the shared 120-second deadline; a late result must not overwrite it.

- [ ] **Step 5: Run MCP unit/integration suites**

```bash
pnpm --filter @agentconnect.md/control-plane test:unit -- src/http/mcp
pnpm --filter @agentconnect.md/control-plane test:int -- test/integration/mcp.route.test.ts test/integration/mcp-delegated.route.test.ts
```

Expected: PASS, including unchanged personal/OAuth tests.

- [ ] **Step 6: Commit**

```bash
git add packages/control-plane/src/http/mcp packages/control-plane/test/integration
git commit -m "feat(control-plane): run delegated calls through MCP"
```

### Task 7: Add mint/revoke WebSocket handlers and recovery reaper

**Files:**

- Create: `packages/control-plane/src/ws/handlers/mcp-invocation-mint.ts`
- Create: `packages/control-plane/src/ws/handlers/mcp-invocation-mint.test.ts`
- Create: `packages/control-plane/src/ws/handlers/webchat-mcp-delegation-revoke.ts`
- Create: `packages/control-plane/src/ws/handlers/webchat-mcp-delegation-revoke.test.ts`
- Create: `packages/control-plane/src/orchestrator/mcpInvocationReaper.ts`
- Create: `packages/control-plane/src/orchestrator/mcpInvocationReaper.test.ts`
- Modify: `packages/control-plane/src/persistence/repositories/agent.repo.ts`
- Create: `packages/control-plane/test/repo/agent-placement-delegation.test.ts`
- Modify: `packages/control-plane/src/orchestrator/agentMove.test.ts`
- Modify: `packages/control-plane/src/ws/deps.ts`
- Modify: `packages/control-plane/src/ws/handlers/index.ts`
- Modify: `packages/control-plane/src/container.ts`
- Modify: `packages/control-plane/src/app.ts`

- [ ] **Step 1: Write failing handler tests**

Prove daemon identity comes only from `DaemonConnection.daemonId`; wrong daemon and stale generation fail; replies correlate and contain no user credential. Prove daemon-originated revoke is daemon/id/generation-fenced and idempotent. Separately prove `setPlacement` and `movePlacement` revoke every active delegation for that agent in the same database transaction, including rollback on a forced placement failure; this CP-observable path must not depend on a daemon frame.

- [ ] **Step 2: Write failing reaper tests**

With a fake clock, prove unused `issued` rows expire, overdue `running` rows become `ambiguous` at exactly 120 seconds, terminal rows live through the 15-minute cache, and delegations are deleted only after dependent invocations are reapable.

- [ ] **Step 3: Run focused tests and confirm RED**

```bash
pnpm --filter @agentconnect.md/control-plane test:unit -- src/ws/handlers/mcp-invocation-mint.test.ts src/ws/handlers/webchat-mcp-delegation-revoke.test.ts src/orchestrator/mcpInvocationReaper.test.ts
pnpm --filter @agentconnect.md/control-plane test:int -- test/repo/agent-placement-delegation.test.ts
```

Expected: FAIL because handlers/reaper are absent.

- [ ] **Step 4: Implement handlers and lifecycle wiring**

Use `conn.replyTo(...)` for success, `INVOCATION_CONFLICT` only for a caller reusing its own known invocation id with a different binding, and one generic `DELEGATION_DENIED` reply for every missing/member/visibility/preset/placement/binding denial. Add equality tests over the complete serialized error replies. Start and stop the reaper with the same ownership pattern as existing reapers. Export one `MCP_INVOCATION_EXECUTION_TIMEOUT_MS` constant used by both route and reaper. In `PgAgentRepo`, update active delegation rows inside the existing `setPlacement`/`movePlacement` transactions whenever placement changes; use reason `agent_placement_changed`. Deletion remains covered by the delegation's agent FK cascade.

- [ ] **Step 5: Run focused tests**

```bash
pnpm --filter @agentconnect.md/control-plane test:unit -- src/ws/handlers/mcp-invocation-mint.test.ts src/ws/handlers/webchat-mcp-delegation-revoke.test.ts src/orchestrator/mcpInvocationReaper.test.ts src/orchestrator/agentMove.test.ts
pnpm --filter @agentconnect.md/control-plane test:int -- test/repo/agent-placement-delegation.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/control-plane/src/ws packages/control-plane/src/orchestrator packages/control-plane/src/persistence/repositories/agent.repo.ts packages/control-plane/test/repo/agent-placement-delegation.test.ts packages/control-plane/src/container.ts packages/control-plane/src/app.ts
git commit -m "feat(control-plane): broker MCP assertions over daemon control"
```

### Task 8: Establish delegations during webchat verification behind a rollout gate

**Files:**

- Modify: `packages/control-plane/src/config/env.ts`
- Modify: `packages/control-plane/src/config/env.test.ts`
- Modify: `packages/control-plane/src/container.ts`
- Modify: `packages/control-plane/src/ws/relay-connection.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Write failing gate/verification tests**

Test default OFF, explicit true parsing, no delegation for non-preset/unentitled/offline/incapable daemons, reuse across tabs/reconnect, and delegation output only when both server gate and daemon capability pass.

- [ ] **Step 2: Run tests and confirm RED**

```bash
pnpm --filter @agentconnect.md/control-plane test:unit -- src/config/env.test.ts src/ws/relay-connection.test.ts
```

Expected: FAIL because the flag and verification extension are absent.

- [ ] **Step 3: Implement disabled-by-default establishment**

Add an explicit string-boolean env such as `WEBCHAT_PRESET_MCP_ENABLED`, default `false`. After ordinary token/owner/placement verification succeeds, call `establish()` only when the gate is true and the placed daemon advertises the feature. Return the optional reference; do not fail ordinary webchat when entitlement is denied.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @agentconnect.md/control-plane test:unit -- src/config/env.test.ts src/ws/relay-connection.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/control-plane/src/config packages/control-plane/src/container.ts packages/control-plane/src/ws/relay-connection.test.ts .env.example
git commit -m "feat(control-plane): gate preset webchat MCP delegation"
```

### Task 9: Propagate trusted delegation references through the relay

**Files:**

- Modify: `packages/relay/src/relay-browser-server.ts`
- Modify: `packages/relay/src/relay-browser-server.test.ts`
- Modify: `packages/relay/src/relay-browser-connection.ts`
- Modify: `packages/relay/src/relay-browser-connection.test.ts`

- [ ] **Step 1: Write failing propagation tests**

Test that the CP-returned immutable reference appears on turn, resume, settings, cancel, and close operations; legacy verification output remains valid; browser JSON/query input cannot set or override the reference. Pin the existing semantic that relay `close` means only browser-transport disconnect: it must never revoke the logical delegation or stop a still-completing turn.

- [ ] **Step 2: Run tests and confirm RED**

```bash
pnpm --filter @agentconnect.md/relay test -- src/relay-browser-server.test.ts src/relay-browser-connection.test.ts
```

Expected: FAIL because the browser connection drops the field.

- [ ] **Step 3: Implement immutable copy-through**

Pass the reference into `RelayBrowserConnection` only from verified server state. Build every `RdMsgWebchat` with that captured reference. Do not add it to browser frame parsers.

- [ ] **Step 4: Run relay tests**

```bash
pnpm --filter @agentconnect.md/relay test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/relay/src/relay-browser-server.ts packages/relay/src/relay-browser-server.test.ts packages/relay/src/relay-browser-connection.ts packages/relay/src/relay-browser-connection.test.ts
git commit -m "feat(relay): carry webchat MCP delegation references"
```

### Task 10: Implement the conversation-private daemon broker

**Files:**

- Create: `packages/daemon/src/mcp/session-mcp-broker.ts`
- Create: `packages/daemon/test/session-mcp-broker.test.ts`
- Modify: `packages/daemon/src/cp/client.ts`
- Create: `packages/daemon/test/cp/delegated-mcp-client.test.ts`
- Modify: `packages/daemon/src/mcp/ipc.ts`
- Modify: `packages/daemon/src/mcp/inject.ts`

- [ ] **Step 1: Write failing immutable-binding tests**

Cover webchat-only registration, cell/conversation reuse rejection, monotonic generation, same-generation idempotence, generation-fenced release, expiry, and derivation of mint fields only from the stored binding.

- [ ] **Step 2: Write failing forwarding tests**

Use a fake CP client/HTTP fetch to prove broker-generated UUIDs ignore runtime JSON-RPC ids; `requestHash` hashes the exact byte buffer later sent; `tools/list` and `tools/call` map to standard MCP JSON; expired assertion remints the same unstarted invocation; expired delegation gives the reconnect error; CP failure affects only the admin server.

- [ ] **Step 3: Run tests and confirm RED**

```bash
pnpm --filter @agentconnect.md/daemon test -- test/session-mcp-broker.test.ts test/cp/delegated-mcp-client.test.ts
```

Expected: FAIL because the broker/client methods do not exist.

- [ ] **Step 4: Implement typed CP request methods**

Add `mintMcpInvocation()` and `revokeWebchatMcpDelegation()` to `CpClient`, both failing fast outside READY/DRAINING and validating the correlated reply type.

- [ ] **Step 5: Implement private listener/binding lifecycle**

Create one `0700` source directory, `0600` socket, and random local token per cell. Keep these tokens in this broker only; never call `McpControlServer.register()`. Expose an `agentconnect-admin` descriptor whose bridge environment contains only the private in-cell socket path and local token.

- [ ] **Step 6: Run broker/client tests**

```bash
pnpm --filter @agentconnect.md/daemon test -- test/session-mcp-broker.test.ts test/cp/delegated-mcp-client.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/daemon/src/mcp packages/daemon/src/cp/client.ts packages/daemon/test/session-mcp-broker.test.ts packages/daemon/test/cp/delegated-mcp-client.test.ts
git commit -m "feat(daemon): add private webchat MCP broker"
```

### Task 11: Add a dedicated host manager per entitled conversation

**Files:**

- Create: `packages/daemon/src/acp/delegated-webchat-host-manager.ts`
- Create: `packages/daemon/test/delegated-webchat-host-manager.test.ts`
- Modify: `packages/daemon/src/acp/acp-host.ts`
- Modify: `packages/daemon/test/acp-host.test.ts`
- Modify: `packages/daemon/src/runtimes/runtime-prober.ts`
- Modify: `packages/daemon/src/runtimes/model-enumerator.ts`
- Modify: `packages/daemon/test/runtime-prober.test.ts`
- Modify: `packages/daemon/test/model-enumerator.test.ts`

- [ ] **Step 1: Write failing host-manager tests**

Prove two conversations on one agent receive distinct cell ids, host processes, runtime homes, mount sources, sockets, and tokens. Prove registration precedes `host.start()` and therefore every `session/new`/`load`. Prove partial startup, host crash, and bridge disconnect release all resources.

- [ ] **Step 2: Run tests and confirm RED**

```bash
pnpm --filter @agentconnect.md/daemon test -- test/delegated-webchat-host-manager.test.ts test/acp-host.test.ts
```

Expected: FAIL because the manager/cell launch contract is absent.

- [ ] **Step 3: Implement the manager**

Key hosts by `(agentId, conversationId)`, never only `agentId`. Allocate a random cell id in trusted daemon memory, create a conversation-private runtime home, register the broker, then start a fresh `AcpHost` with the delegated bwrap mount. Refuse construction unless the delegated isolation probe is healthy.

- [ ] **Step 4: Extend `AcpHost` through a narrow trusted option**

Add a launch option that carries the daemon-owned broker source root into every bwrap launch's `maskedReadRoots`, plus the already-validated delegated cell bind only for an entitled host. Update and test the daemon's normal host construction in `daemon.ts`, runtime probes in `runtimes/runtime-prober.ts`, and model enumeration in `runtimes/model-enumerator.ts`; these are every untrusted ACP process a capability-advertising daemon can spawn. Standalone CLI chat/evaluation processes do not advertise the daemon capability and remain outside this gate. Do not put cell id, delegation id, generation, assertion, user id, or CP authority into ACP session parameters or model context.

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @agentconnect.md/daemon test -- test/delegated-webchat-host-manager.test.ts test/acp-host.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/acp packages/daemon/test/delegated-webchat-host-manager.test.ts packages/daemon/test/acp-host.test.ts
git commit -m "feat(daemon): isolate entitled webchat hosts"
```

### Task 12: Route entitled webchat sessions through dedicated hosts

**Files:**

- Modify: `packages/daemon/src/daemon.ts`
- Modify: `packages/daemon/src/session/session-manager.ts`
- Modify: `packages/daemon/test/daemon-webchat.test.ts`
- Create: `packages/daemon/test/delegated-webchat-lifecycle.test.ts`

- [ ] **Step 1: Write failing admission tests**

Prove only trusted-envelope webchat + preset agent + valid unexpired delegation + healthy isolation selects the dedicated host and admin descriptor. Prove Slack/hook/cron/dream/A2A, ordinary-agent webchat, missing delegation, and unsupported isolation use ordinary behavior without admin MCP.

- [ ] **Step 2: Write failing generation/lifecycle tests**

Prove same generation/concurrent tabs reuse one logical cell; lower generation cannot replace; higher generation drains/stops/releases old binding before fresh registration/load; failed replacement never restores stale authority. Prove restart reattaches from the next `rd/msg`; local-store TTL transition to `closed`, explicit logical-session termination if one is added later, and agent detach send the fenced revoke; daemon shutdown clears local resources without revoking. Prove the relay's automatic browser `close` operation is transport observability only and neither revokes nor tears down the cell.

- [ ] **Step 3: Run tests and confirm RED**

```bash
pnpm --filter @agentconnect.md/daemon test -- test/daemon-webchat.test.ts test/delegated-webchat-lifecycle.test.ts
```

Expected: FAIL because all webchat still uses the agent-scoped host.

- [ ] **Step 4: Implement trusted-envelope selection and serialized replacement**

Maintain a per-`(agentId, conversationId)` gate. Never copy a binding from payload at tool-call time; capture it once while admitting the trusted relay envelope. Wait for broker registration and ACP initialization before delivering the first prompt.

- [ ] **Step 5: Implement teardown/revocation paths**

Destroy host, listener, token, mount source, and immutable binding together. Revoke only a real logical close (today the local-store idle/TTL transition), logical expiry, or detach; never revoke on a browser socket/relay `close`. Ordinary daemon shutdown preserves CP delegation for restart. Hook dedicated-cell cleanup into the existing `sweepIdle()` rows returned by `closeIdleSessions()`, using the stored webchat conversation coordinates to find the binding.

- [ ] **Step 6: Run daemon lifecycle tests**

```bash
pnpm --filter @agentconnect.md/daemon test -- test/daemon-webchat.test.ts test/delegated-webchat-lifecycle.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/daemon/src/daemon.ts packages/daemon/src/session/session-manager.ts packages/daemon/test/daemon-webchat.test.ts packages/daemon/test/delegated-webchat-lifecycle.test.ts
git commit -m "feat(daemon): host delegated webchat conversations"
```

### Task 13: Advertise capability only after the complete isolation path exists

**Files:**

- Modify: `packages/daemon/src/daemon.ts`
- Create: `packages/daemon/test/delegated-mcp-capability.test.ts`
- Modify: `packages/control-plane/test/integration/relay-gateway.test.ts`

- [ ] **Step 1: Write failing capability tests**

Assert the capability is absent for optional sandboxing, macOS, missing/failed bwrap, unhealthy broker root, or disabled dedicated-host support. Assert it is present only when daemon-wide bwrap confinement and the private host/broker path are ready.

- [ ] **Step 2: Run tests and confirm RED**

```bash
pnpm --filter @agentconnect.md/daemon test -- test/delegated-mcp-capability.test.ts
pnpm --filter @agentconnect.md/control-plane test:int -- test/integration/relay-gateway.test.ts
```

Expected: FAIL because capability emission is absent.

- [ ] **Step 3: Emit the shared feature constant**

Add `DELEGATED_MCP_ASSERTION_FEATURE` to registration features only when the complete health predicate is true. Keep CP rollout gate default false.

- [ ] **Step 4: Run tests**

Run the commands from Step 2.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/daemon.ts packages/daemon/test/delegated-mcp-capability.test.ts packages/control-plane/test/integration/relay-gateway.test.ts
git commit -m "feat: advertise delegated MCP isolation capability"
```

### Task 14: Add the required copied-socket/token security regression

**Files:**

- Create: `packages/daemon/test/delegated-mcp-cross-cell.test.ts`
- Modify: `packages/daemon/test/mcp-control-server.test.ts`

- [ ] **Step 1: Write the real-process regression before implementation adjustments**

Start two entitled cells A and B for two users on the same preset, plus one ordinary non-entitled bwrap ACP sibling C. Give A and C B's exact host source path, in-cell path, and local token before B's bridge first connects. Assert neither attacker can resolve/connect to B, A's own endpoint rejects B's token, the shared `McpControlServer` rejects B's token, and no B-bound mint frame is emitted.

- [ ] **Step 2: Repeat after victim activation**

Let B connect and complete `tools/list`, then repeat every copied path/token attempt from both entitled A and ordinary sibling C and assert the same denials/no mint.

- [ ] **Step 3: Run on Linux and confirm the test detects an intentionally shared mount**

```bash
pnpm --filter @agentconnect.md/daemon test -- test/delegated-mcp-cross-cell.test.ts
```

Expected: PASS with production layout; as a test-quality check, temporarily use a shared source mount and confirm FAIL, then restore production configuration.

- [ ] **Step 4: Tighten implementation only if the test exposes a gap**

Keep the common broker source root masked by tmpfs in **every bwrap ACP host**, including ordinary non-entitled hosts, and bind only the entitled cell's source directory at the fixed private target.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/test/delegated-mcp-cross-cell.test.ts packages/daemon/test/mcp-control-server.test.ts packages/daemon/src
git commit -m "test(daemon): prove delegated MCP cross-cell isolation"
```

### Task 15: Add end-to-end identity, privacy, failure, and observability coverage

**Files:**

- Create: `packages/control-plane/test/integration/webchat-preset-mcp.e2e.test.ts`
- Create: `packages/control-plane/test/fixtures/webchat-preset-mcp-harness.ts`
- Create: `packages/daemon/test/fixtures/delegated-mcp-acp-agent.mjs`
- Create: `packages/daemon/test/delegated-mcp-acp-fixture.test.ts`
- Modify: `.github/workflows/test.yaml`
- Create: `packages/control-plane/src/http/mcp/metrics.ts`
- Create: `packages/control-plane/src/http/mcp/metrics.test.ts`
- Create: `packages/daemon/src/mcp/delegated-metrics.ts`
- Create: `packages/daemon/test/delegated-metrics.test.ts`
- Modify: `packages/control-plane/src/registry/webchatMcpDelegationService.ts`
- Modify: `packages/control-plane/src/http/mcp/routes.ts`
- Modify: `packages/daemon/src/mcp/session-mcp-broker.ts`
- Modify: `packages/daemon/src/acp/delegated-webchat-host-manager.ts`

- [ ] **Step 1: Create and smoke-test an MCP-capable ACP fixture**

Create `delegated-mcp-acp-agent.mjs` as a minimal ACP peer that implements
`initialize`, `session/new`, `session/load`, and `session/prompt`. Capture the
`mcpServers` descriptors delivered by the host. On a prompt, spawn the selected
descriptor's exact stdio `command`, `args`, and `env`, complete MCP
`initialize`, call `tools/list`, invoke the requested tool with `tools/call`,
and return the tool result through the ACP update/final response. Do not import
or call daemon broker internals from the fixture.

Add a focused daemon test that gives the fixture a fake injected stdio MCP
server and proves the complete ACP-to-MCP handshake and tool call work. This
prevents the end-to-end test from passing with an ACP fixture that merely
echoes prompts and never consumes the injected MCP descriptor.

- [ ] **Step 2: Write a real cross-package two-user end-to-end test**

Build one composition harness inside the CP integration project that imports
the real relay and daemon source modules, boots `buildApp()` against the
pool-local Testcontainers Postgres, starts a real relay browser/daemon socket
pair on ephemeral ports, and starts a daemon using
`packages/daemon/test/fixtures/delegated-mcp-acp-agent.mjs` under bwrap. Drive
an actual browser WebSocket through
`rc/verify → rd/msg → dedicated ACP host → private broker → daemon WS mint → POST /api/v1/mcp`.
Create two members with different roles/visibility, two conversations on the
same preset, two delegations, and two cells. Verify distinct actor/audit
identity, role change on next call, hidden resources remain 404, private
session list/detail/messages isolation, owner governance read does not permit
join/send, and host-agent mutations fail.

- [ ] **Step 3: Add failure-path tests**

Cover CP outage preserving chat/local tools, assertion expiration/remint, delegation expiration/reconnect, membership removal, agent move, request-byte mismatch, replay/in-progress/cached/ambiguous behavior, and absence of assertion/user credentials in ACP config, child env, transcript, telemetry, and captured logs.

- [ ] **Step 4: Run the end-to-end tests and confirm RED for missing metrics/edge cases**

```bash
pnpm --filter @agentconnect.md/control-plane test:int -- test/integration/webchat-preset-mcp.e2e.test.ts
pnpm --filter @agentconnect.md/daemon test -- test/delegated-mcp-acp-fixture.test.ts test/delegated-mcp-cross-cell.test.ts test/delegated-webchat-lifecycle.test.ts
```

The composition test may skip locally only when `process.platform !== 'linux'` or bwrap is unavailable. Add a dedicated unsharded Linux CI step/job in `.github/workflows/test.yaml` that installs `bubblewrap` and runs exactly this file, so the required acceptance proof cannot be skipped in CI.

- [ ] **Step 5: Add bounded non-secret metrics/logs**

Add counters/histograms from design §15 with stable reason codes. Logs may include only invocation, delegation, agent, conversation, and reason; never assertion/hash/body/credential headers. Add explicit tests against captured log output.

- [ ] **Step 6: Run package verification**

```bash
pnpm --filter @agentconnect.md/protocol test
pnpm --filter @agentconnect.md/control-plane test
pnpm --filter @agentconnect.md/relay test
pnpm --filter @agentconnect.md/daemon test
pnpm typecheck
pnpm lint
pnpm format:check
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages .github/workflows/test.yaml
git commit -m "test: verify preset webchat MCP end to end"
```

### Task 16: Enable compatible deployments and document operations

**Files:**

- Modify: `docs/designs/webchat-preset-agentconnect-mcp.md`
- Modify: `docs/product-conventions.md` only if a new user-facing error convention is needed
- Modify: `.env.example`
- Modify: `docs/designs/daemon-detailed-design.md`

- [ ] **Step 1: Add rollout documentation**

Document Linux+bwrap, daemon-wide sandbox enforcement, the CP gate, capability diagnostics, 12-hour delegation ceiling, 30-second assertion claim, two-minute ambiguous timeout, and the fact that unsupported daemons continue ordinary webchat without admin tools. Do not expose internal component names in console copy.

- [ ] **Step 2: Run documentation and full-repository checks**

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Expected: PASS.

- [ ] **Step 3: Inspect the final diff for secret-bearing surfaces**

```bash
git diff origin/main...HEAD -- packages docs .env.example
rg -n "assertion|AC_MCP_TOKEN|authorization" packages/daemon/src packages/control-plane/src
```

Expected: every occurrence is a schema/variable/security comment or redacted handling path; no assertion/body/header logging and no delegated context on shared MCP registration.

- [ ] **Step 4: Enable the deployment gate only after Linux CI passes**

Treat this as an explicit operator checkpoint. Repository code and
`.env.example` keep the default `false`; do not commit a deployment-config
mutation unless the target deployment configuration is in this repository and
the operator has separately authorized that rollout. After the
copied-socket/token test and full Linux CI pass, hand off the exact opt-in
setting `WEBCHAT_PRESET_MCP_ENABLED=true` for compatible target deployments.
This is an operational rollout, not a user-facing setting.

- [ ] **Step 5: Commit documentation**

```bash
git add docs .env.example
git commit -m "docs: explain preset webchat MCP rollout"
```

## Final verification checklist

- [ ] `git status --short` is clean.
- [ ] Every production behavior was introduced by a failing test first.
- [ ] Personal-key and OAuth MCP behavior remains unchanged.
- [ ] Old relay/daemon protocol payloads still decode.
- [ ] CP is not on the webchat content hot path.
- [ ] A delegation reference alone cannot call MCP.
- [ ] Assertion execution is exact-byte, 30-second claim, one-CAS-winner, and byte-for-byte cached.
- [ ] The HTTP timeout and reaper share exactly `120_000` ms.
- [ ] Delegated self-host `updateAgent`/`deleteAgent` are denied before REST dispatch.
- [ ] No assertion, reusable user credential, request body, or response body is logged/audited/transcribed.
- [ ] Delegated state never enters `McpControlServer.sessions`.
- [ ] Entitled and ordinary bwrap siblings remain isolated before and after the victim bridge connects.
- [ ] Browser/relay transport close never revokes a logical-session delegation.
- [ ] CP placement change revokes active delegations transactionally without daemon cooperation.
- [ ] Unsupported/CP-down cases preserve ordinary webchat and daemon-local tools.
- [ ] The Linux composition test traverses browser, relay, daemon, CP mint, and standard MCP HTTP in one run.
- [ ] Full `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm build` pass.
