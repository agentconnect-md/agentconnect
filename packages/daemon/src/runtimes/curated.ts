import type { RuntimeDef } from '../config/config-schema.js'

export interface CuratedRuntimeEntry {
  name: string
  runtime: RuntimeDef
}

/**
 * Reviewed native ACP stdio commands that are not guaranteed to exist in the
 * public ACP registry. This is a launch catalog, not an installer: host
 * discovery still requires the executable and initialized local state.
 *
 * Display marks for these ids live web-side in the /api/acp-registry route
 * (packages/web) — the console is their only consumer. Keep the ids in sync.
 */
export const CURATED_RUNTIME_CATALOG: Readonly<Record<string, CuratedRuntimeEntry>> = Object.freeze({
  'hermes-agent': {
    name: 'Hermes Agent',
    runtime: { command: 'hermes', args: ['acp'], env: [], skillsAgentId: 'hermes-agent' }
  },
  'open-interpreter': {
    name: 'Open Interpreter',
    runtime: { command: 'interpreter', args: ['acp'], env: [] }
  },
  'kiro-cli': {
    name: 'Kiro CLI',
    runtime: { command: 'kiro-cli', args: ['acp'], env: [], skillsAgentId: 'kiro-cli' }
  },
  maki: {
    name: 'Maki',
    runtime: { command: 'maki', args: ['acp'], env: [] }
  },
  zeroclaw: {
    name: 'ZeroClaw',
    runtime: { command: 'zeroclaw', args: ['acp'], env: [] }
  },
  omp: {
    name: 'Oh My Pi',
    runtime: { command: 'omp', args: ['acp'], env: [] }
  },
  // Qoder CLI launches its ACP server via a `--acp` flag (not an `acp`
  // subcommand). Distributed as @qoder-ai/qodercli; the `qodercli` binary is on
  // PATH once installed globally.
  'qoder-cli': {
    name: 'Qoder CLI',
    runtime: { command: 'qodercli', args: ['--acp'], env: [], skillsAgentId: 'qoder' }
  },
  // Qoder CN CLI (Lingma) is the same product line for the China region,
  // distributed as @qodercn-ai/qoderclicn with the `qoderclicn` binary and its
  // own ~/.qoder-cn state dir. Same `--acp` launch flag.
  'qoder-cli-cn': {
    name: 'Qoder CN CLI',
    runtime: { command: 'qoderclicn', args: ['--acp'], env: [], skillsAgentId: 'qoder-cn' }
  },
  // DeepSeek Harness speaks ACP through @openma/deepseek-harness-acp, which
  // bundles the harness itself and only reuses $DSH_HOME credentials — so it is
  // fetched on demand rather than installed into the operator's dsh profile.
  // `-p` is required: the package's single bin (`dsh-acp`) is not its name.
  // Its skill provider scans `<projectRoot>/.agents/skills`, which is exactly what the CLI's
  // `universal` identity writes; `dsh` is not a CLI agent id.
  'dsh-acp': {
    name: 'DeepSeek Harness',
    runtime: {
      command: 'npx',
      args: ['-y', '-p', '@openma/deepseek-harness-acp@^0.4', 'dsh-acp'],
      env: [],
      skillsAgentId: 'universal'
    }
  },
  // `openclaw acp` (OpenClaw 2.0+) is a thin stdio bridge: execution lives in the
  // machine-local OpenClaw Gateway (ws://127.0.0.1:18789 by default), and the
  // bridge reads the gateway address + token from ~/.openclaw/openclaw.json.
  // externalExecution: sandboxing the bridge would contain nothing (the Gateway
  // executes) while netns isolation severs its loopback dial.
  openclaw: {
    name: 'OpenClaw',
    runtime: { command: 'openclaw', args: ['acp'], env: [], skillsAgentId: 'openclaw', externalExecution: true }
  }
})
