import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve, isAbsolute, dirname } from 'node:path'
import { AgentSchema, type Agent } from './agent-schema.js'

const IGNORED_DIRS = new Set(['node_modules', '.git'])
const MAX_DEPTH = 4

// Agent plus loader-derived data: the directory containing agent.json.
export type LoadedAgent = Agent & { dir: string }

// Parse one agent.json, then resolve workspace.path relative to the agent dir.
function parseAgentFile(file: string): LoadedAgent {
  const dir = dirname(file)
  const agent = AgentSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
  if (!isAbsolute(agent.workspace.path)) {
    agent.workspace.path = resolve(dir, agent.workspace.path)
  }
  return { ...agent, dir }
}

// Bounded recursive walk: collect every agent.json under `dir`. A directory that
// contains an agent.json is treated as a leaf (we do not recurse into it), so an
// agent's own workspace checkout can't masquerade as nested agents.
export function findAgentFiles(dir: string, depth = 0): string[] {
  if (depth > MAX_DEPTH || !existsSync(dir)) return []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  if (entries.some((e) => e.isFile() && e.name === 'agent.json')) {
    return [join(dir, 'agent.json')]
  }
  const out: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
    out.push(...findAgentFiles(join(dir, entry.name), depth + 1))
  }
  return out
}

// All parsed agents under `agentsDir`, no status filter. `dir` is the directory
// holding each agent.json.
export function discoverAgents(agentsDir: string): { agent: LoadedAgent; dir: string }[] {
  return findAgentFiles(agentsDir).map((file) => {
    try {
      return { agent: parseAgentFile(file), dir: dirname(file) }
    } catch (err) {
      throw new Error(`invalid agent.json at ${file}: ${(err as Error).message}`)
    }
  })
}

// Active agents only — the daemon's multi-agent path.
export function loadAgents(agentsDir: string): LoadedAgent[] {
  return discoverAgents(agentsDir)
    .map((d) => d.agent)
    .filter((a) => a.status === 'active')
}

// Resolve a single agent from `agentsDir`. With `name`, matches the agent `id`.
// Without `name`: requires exactly one discovered agent. Used by `chat` and by
// `run --agent`. Does NOT filter by status.
export function selectAgent(agentsDir: string, name?: string): LoadedAgent {
  const agents = discoverAgents(agentsDir).map((d) => d.agent)
  if (name) {
    const match = agents.find((a) => a.id === name)
    if (!match) {
      const available =
        agents
          .map((a) => a.id)
          .sort()
          .join(', ') || '(none)'
      throw new Error(`agent "${name}" not found in ${agentsDir}. Available: ${available}`)
    }
    return match
  }
  if (agents.length === 0) throw new Error(`no agent.json found in ${agentsDir}`)
  if (agents.length > 1) {
    const ids = agents
      .map((a) => a.id)
      .sort()
      .join(', ')
    throw new Error(`multiple agents found in ${agentsDir}: ${ids}; use --agent <name> to specify one`)
  }
  return agents[0]!
}
