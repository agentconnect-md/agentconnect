import { z } from 'zod'
import { Platform, RouteAssign } from './route.js'
import { CronUpsert } from './cron.js'
import { SecretsGrant } from './secrets.js'
import { AgentSpec } from './agent.js'
import { IntegrationSpec } from './integration.js'
import { McpServerSpec } from './mcpserver.js'
import { MemoryConnectionSpec } from './memory-connection.js'
import { CollabRoutesSnapshot } from './collab.js'
import { GitCommitIdentity } from './gitcred.js'

/**
 * Capability upload + the reconcile snapshot — protocol §3.3.
 *
 * `register/ok` is the authoritative source of truth: the daemon converges its
 * local cache to it. CP wins all conflicts, so re-issuing the same snapshot is
 * idempotent.
 */

export const RegisterReq = z.object({
  host: z.string(), // hostname (display only)
  capabilities: z.object({
    platforms: z.array(Platform), // D3 adapters present
    runtimes: z.array(z.string()), // e.g. ["claude","codex"]
    acp: z.boolean(), // can this daemon host ACP sessions (D6)?
    features: z.array(z.string()).default([]) // e.g. ["cli-wrapper-fallback","worktree-iso"]
  }),
  maxAgents: z.number().int(), // concurrency ceiling for placement (C3)
  localState: z.object({
    // what the daemon currently believes it owns (for reconcile)
    assignments: z.array(z.string()), // sessionKeys it is actively serving
    crons: z.array(z.string()), // cronIds it has scheduled
    leases: z.array(z.string()), // leaseIds it holds
    // Active on-disk replicas. `unknown` is the rolling-upgrade/legacy value:
    // the CP may prune it only when the durable row proves the replica moved.
    // Defaults keep an older daemon compatible with a newer CP.
    agents: z.array(z.object({ agentId: z.string(), origin: z.enum(['cp', 'unknown']) })).default([]),
    integrations: z.array(z.object({ integrationId: z.string(), origin: z.enum(['cp', 'unknown']) })).default([]),
    // Durable fail-closed move tombstones. A newer CP repairs entries with a
    // valid token after register/ok. A missing token represents corrupt local
    // metadata: the daemon keeps that agent drained for manual repair without
    // making the whole registration undecodable.
    stagedAgents: z.array(z.object({ agentId: z.string(), moveId: z.string().uuid().optional() })).default([])
  })
})
export type RegisterReq = z.infer<typeof RegisterReq>

/**
 * One relay the daemon SHOULD hold an outbound WS to (shared-bot-relay.md §5).
 * The roster is all-to-all by design: a webchat/webhook landing on ANY relay
 * instance must find this daemon's connection without cross-instance forwarding.
 * That only holds if `url` (the relay's registered `daemonUrl`) routes to that
 * SPECIFIC instance — the daemon confirms the landing spot against
 * `rd/hello/ok.relayId` and treats a mismatch as a deployment misroute.
 */
export const RelayRosterEntry = z.object({
  relayId: z.string().uuid(),
  url: z.string() // the relay's daemonUrl — per-instance routable, never a pool LB
})
export type RelayRosterEntry = z.infer<typeof RelayRosterEntry>

/**
 * C→D EVT (`relay/roster`) — hot roster update (relay registered / swept).
 * Carries the WHOLE desired set, same converge-don't-diff semantics as the
 * `register/ok.relays` snapshot it refreshes.
 */
export const RelayRosterUpdate = z.object({
  relays: z.array(RelayRosterEntry)
})
export type RelayRosterUpdate = z.infer<typeof RelayRosterUpdate>

export const RegisterOk = z.object({
  routingEpoch: z.number().int(), // version of the routing table this snapshot reflects
  // CP protocol capabilities. Default keeps a new daemon compatible with an
  // older CP during rolling deploys; old daemons ignore this additive field.
  serverFeatures: z.array(z.string()).default([]),
  // Public attribution for github-app workspace commits. Derived from this
  // deployment's App slug; optional so new daemons still accept an older CP.
  gitCommitIdentity: GitCommitIdentity.optional(),
  // Authoritative reconcile snapshot — daemon converges its local cache to this:
  assignments: z.array(RouteAssign), // the route/assign set the daemon SHOULD own
  agents: z.array(AgentSpec.extend({ agentId: z.string().uuid() })).default([]), // spec set CP wants present; daemon converges
  crons: z.array(CronUpsert), // the cron set it SHOULD run
  // Platform integrations this daemon SHOULD hold — FILTERED to this daemon (never
  // org-wide), since each element carries plaintext tokens. Never log this array.
  integrations: z.array(IntegrationSpec).default([]),
  // MCP server defs this daemon SHOULD hold — FILTERED to this daemon (only providers
  // its agents enable). In the MCP-proxy model these carry a relay proxy URL + a bearer
  // grant key (not the upstream secret), but treat as sensitive — never log this array.
  // Defaulted so a pre-MCP-registry CP's snapshot still parses.
  mcpServers: z.array(McpServerSpec).default([]),
  // External-memory defs this daemon's agents reference. Relay grants and local
  // secret leases are daemon-private and must never be logged.
  memoryConnections: z.array(MemoryConnectionSpec).default([]),
  leases: z.array(SecretsGrant), // secret leases it SHOULD hold
  // Relay roster — the relays this daemon SHOULD dial (webchat ingress now;
  // shared-bot/webhook with milestone B). Hot updates ride `relay/roster`;
  // defaulted so a pre-relay CP's snapshot still parses.
  relays: z.array(RelayRosterEntry).default([]),
  // Bot-agnostic collaboration routing snapshot (agent-collaboration §2.3 / §6.5) —
  // the reconnect BASELINE for this daemon's terminal-verify of REMOTE agent callers.
  // Scoped to channels this daemon's agents participate in. Hot changes ride the
  // `collaboration/routes` EVT. Defaulted so a pre-collab CP's snapshot still parses.
  collabRoutes: CollabRoutesSnapshot.default({ generation: 0, channels: [], agents: [] }),
  drop: z.object({
    // things in localState the CP says to release
    assignments: z.array(z.string()),
    crons: z.array(z.string()),
    // A missed live move archives the replica (preserving workspace/memory); a
    // missed delete removes a replica that carries the explicit CP marker.
    agents: z.array(z.object({ agentId: z.string(), action: z.enum(['detach', 'remove']) })).default([]),
    integrations: z.array(z.string()).default([])
  })
})
export type RegisterOk = z.infer<typeof RegisterOk>
