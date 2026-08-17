import type { Stats } from 'node:fs'
import { basename, isAbsolute, relative, sep } from 'node:path'
import type { MemoryDreamingPolicy } from '@agentconnect.md/protocol'
import { effectiveMemoryDreamingPolicy } from '@agentconnect.md/protocol'
import { SandboxError, sandboxBoundary } from '../acp/sandbox.js'
import type { Agent } from '../agents/agent-schema.js'
import type { LoadedAgent } from '../agents/load-agents.js'
import type { Config } from '../config/config-schema.js'
import { runtimeHomePath } from '../runtimes/runtime-home.js'

export function ignoreAgentWatchPath(agentsDir: string, path: string, stats?: Stats): boolean {
  const segments = relative(agentsDir, path).split(sep)
  if (segments.some((segment) => segment === 'node_modules' || segment.startsWith('.'))) return true
  return stats !== undefined && !stats.isDirectory() && basename(path) !== 'agent.json'
}

/** Validate the same trusted workspace boundary that every real ACP spawn will
 * receive, before clone/skill preparation can mutate that path. Canonical
 * workspace-root aliases and overlaps are exclusive across local agent
 * principals. The separate durable ledger serializes and owns the exact
 * prepared ACP cwd; it is not the authority for this broader root check. */
export function assertExclusiveAgentWorkspaces(agents: readonly LoadedAgent[]): void {
  const workspaces: Array<{ agentId: string; path: string }> = []
  for (const agent of agents) {
    const workspace = sandboxBoundary({
      agentDir: agent.dir,
      cwd: agent.workspace.path,
      runtimeHome: runtimeHomePath(agent.dir)
    }).gitSafeDirectories?.[0]
    if (!workspace) throw new SandboxError(`sandbox workspace boundary is missing for agent "${agent.id}"`)
    for (const existing of workspaces) {
      if (existing.agentId === agent.id) continue
      const fromExisting = relative(existing.path, workspace)
      const fromWorkspace = relative(workspace, existing.path)
      const overlaps =
        fromExisting === '' ||
        (!isAbsolute(fromExisting) && fromExisting !== '..' && !fromExisting.startsWith(`..${sep}`)) ||
        (!isAbsolute(fromWorkspace) && fromWorkspace !== '..' && !fromWorkspace.startsWith(`..${sep}`))
      if (overlaps) {
        throw new SandboxError(
          `agents "${existing.agentId}" and "${agent.id}" have overlapping writable workspaces ` +
            `"${existing.path}" and "${workspace}"`
        )
      }
    }
    workspaces.push({ agentId: agent.id, path: workspace })
  }
}

export function mergeAgentWorkspaceAuthorities(...sets: readonly LoadedAgent[][]): LoadedAgent[] {
  const byId = new Map<string, LoadedAgent>()
  for (const agents of sets) {
    for (const agent of agents) {
      const existing = byId.get(agent.id)
      if (existing && existing.dir !== agent.dir) {
        throw new SandboxError(
          `duplicate active agent id "${agent.id}" appears in "${existing.dir}" and "${agent.dir}"`
        )
      }
      byId.set(agent.id, agent)
    }
  }
  return [...byId.values()]
}

/**
 * Does this Telegram failure just mean the bot is ALREADY out of the chat?
 *
 * Telegram offers no "am I in this chat" query, so the only way to learn it is to try
 * to leave and read the refusal. These are the `description`s the Bot API returns from
 * `leaveChat` for a chat the bot cannot be in — removed, kicked, or the chat is gone.
 * Anything else is a genuine failure and must still reach the operator.
 *
 * Matching on message text is a heuristic, and deliberately a safe one: a mis-read
 * error only retires a row that is still live, which is the already-documented
 * behaviour of a removed row — it returns on that conversation's next message.
 */
export function isAlreadyOutOfChat(err: unknown): boolean {
  const message = ((err as { message?: string })?.message ?? '').toLowerCase()
  return message.includes('chat not found') || message.includes('bot was kicked') || message.includes('not a member')
}

/** An agent's effective dreaming policy. Managed memory defaults to a daily,
 *  review-first dream; an explicit disabled policy or non-managed provider is
 *  preserved by the shared resolver. */
export function dreamingPolicyOf(agent: { memory?: Agent['memory'] } | undefined): MemoryDreamingPolicy | undefined {
  if (!agent) return undefined
  return effectiveMemoryDreamingPolicy(agent.memory)
}

/** Connectable when there is a URL and a credential: an API key, or — in-cluster — the
 *  projected ServiceAccount token this pod presents instead of one. */
export function configuredControlPlane(
  controlPlane: Config['controlPlane'],
  hasClusterIdentity = false
): controlPlane is Config['controlPlane'] & { url: string } {
  return controlPlane.enabled && !!controlPlane.url && (!!controlPlane.key || hasClusterIdentity)
}

/**
 * How long a paired `toAgent + channel` rendezvous waits for its other half
 * (send-message-routing-rework.md §3.2/§8.6).
 *
 * It bounds the window in which a platform observation and its internal wake are treated
 * as one delivery. Generous, because the two halves may cross a relay, a slow platform
 * fan-out, or a target-daemon restart; on expiry the pairing becomes transcript-only and
 * raises a delivery failure rather than dispatching an envelope-less child.
 */
export const ACTIVATION_PAIRING_TTL_MS = 10 * 60 * 1000

/** Composite-key separator for the activation rendezvous. NOT NUL: these keys and their
 *  transcript coordinates are stored, and the pool store is PostgreSQL, whose TEXT rejects 0x00. */
export const ACTIVATION_KEY_SEPARATOR = '\u001f'

/**
 * The key that makes one logical delivery admissible exactly once
 * (send-message-routing-rework.md §3.2).
 *
 * Scoped by transport as well as platform because two bot connections can receive the
 * SAME `channel:ts`, and by TARGET because one visible post may address several agents —
 * each of which must be admitted once, independently of the others.
 */
export function activationKey(
  platform: string,
  transportScope: string | undefined,
  platformMessageId: string,
  targetAgentId: string
): string {
  return [platform, transportScope ?? '', platformMessageId, targetAgentId].join(ACTIVATION_KEY_SEPARATOR)
}

/** The platform `ts` inside a Slack `msgId` (`slack:<channel>:<ts>`). The ts — not the
 *  msgId — is the visible message's identity, which is what the activation key and the
 *  paired wake both name. A response finalization carries the ORIGINAL post's msgId and
 *  marks itself with `ingressEventTag`, so nothing has to be stripped here. */
export function slackTsFromMsgId(msgId: string): string {
  return msgId.split(':')[2] ?? msgId
}
