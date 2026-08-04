import { loadConfig } from '../config/load-config.js'
import { discoverAgents } from '../agents/load-agents.js'

export interface RunAgentListOpts {
  agentsDir?: string
  configPath?: string
  root?: string
  out?: NodeJS.WritableStream
}

// Read-only view of the local agent directory. Mutating agents (add/remove/
// enable/disable) is intentionally not a CLI command — agent business config is
// supplied in memory by the Control Plane (agent/upsert + register/ok roster,
// see cp/cp-agent-registry.ts) or by hand-editing agent.json. This command lists
// only what local-file discovery sees.
export async function runAgentList(opts: RunAgentListOpts): Promise<void> {
  const out = opts.out ?? process.stdout
  const cfg = loadConfig({
    root: opts.root,
    configPath: opts.configPath,
    optional: true,
    overrides: { agentsDir: opts.agentsDir }
  })
  const agentsDir = cfg.agentsDir!
  const discovered = discoverAgents(agentsDir)
  if (discovered.length === 0) {
    out.write(`no agents found under ${agentsDir}\n`)
    return
  }
  for (const { agent, dir } of discovered) {
    out.write(`${agent.id}\t${agent.status}\t${agent.runtime}\t${agent.name}\t${dir}\n`)
  }
}
