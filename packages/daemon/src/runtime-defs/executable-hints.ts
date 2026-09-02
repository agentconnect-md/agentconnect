import type { RuntimeDef } from '../config/config-schema.js'
import { isClaudeRuntimeDef } from './claude-runtime.js'

/** An env pointer at a host executable the adapter needs, resolved by whoever knows its filesystem. */
export interface RuntimeExecutableHint {
  envVar: string
  command: string
}

/** A codex-acp runtime (its command/args reference `codex-acp`), including the managed npx fork. */
function isCodexRuntimeDef(runtime: RuntimeDef): boolean {
  return [runtime.command, ...runtime.args].some((part) => /(?:^|[\\/@])codex-acp(?:@[^\\/]*)?$/i.test(part))
}

/** The hints a runtime accepts, shared so the sandbox carves back exactly the executables a launch injects. */
export function runtimeExecutableHints(runtime: RuntimeDef): RuntimeExecutableHint[] {
  return [
    // The claude-agent-sdk finds its CLI in a bundled OPTIONAL npm dep (often absent under npx) or here.
    ...(isClaudeRuntimeDef(runtime) ? [{ envVar: 'CLAUDE_CODE_EXECUTABLE', command: 'claude' }] : []),
    // codex-acp reuses an installed Codex CLI at CODEX_PATH instead of its bundled fallback.
    ...(isCodexRuntimeDef(runtime) ? [{ envVar: 'CODEX_PATH', command: 'codex' }] : [])
  ]
}
