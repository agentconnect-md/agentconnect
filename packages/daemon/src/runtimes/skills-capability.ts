import type { RuntimeDef } from '../config/config-schema.js'

/**
 * Audited identity compatibility between AgentConnect runtime ids and the
 * exact skills CLI version bundled with this daemon. This is deliberately an
 * agent identity table, never a filesystem-layout table: the CLI remains the
 * sole authority for destinations.
 *
 * A new harness is unsupported until onboarding verifies its CLI identity and
 * real discovery behavior, then adds that identity here (or declares it in an
 * operator-owned RuntimeDef). Similar-looking names are never guessed.
 */
export const AUDITED_RUNTIME_SKILLS_AGENTS: Readonly<Record<string, string>> = Object.freeze({
  // Legacy/local runtime ids still present in existing agent.json files.
  claude: 'claude-code',
  codex: 'codex',

  // Public ACP registry ids audited against skills@1.5.21.
  'amp-acp': 'amp',
  auggie: 'augment',
  autohand: 'autohand-code',
  'claude-acp': 'claude-code',
  cline: 'cline',
  'codebuddy-code': 'codebuddy',
  'codex-acp': 'codex',
  'cortex-code': 'cortex',
  cursor: 'cursor',
  deepagents: 'deepagents',
  devin: 'devin',
  'factory-droid': 'droid',
  gemini: 'gemini-cli',
  'github-copilot-cli': 'github-copilot',
  goose: 'goose',
  'grok-build': 'grok',
  junie: 'junie',
  kilo: 'kilo',
  kimi: 'kimi-code-cli',
  'mistral-vibe': 'mistral-vibe',
  opencode: 'opencode',
  'pi-acp': 'pi',
  qoder: 'qoder',
  'qwen-code': 'qwen-code',

  // Curated/legacy ids whose RuntimeDef also carries the declaration.
  hermes: 'hermes-agent',
  'hermes-agent': 'hermes-agent',
  // DeepSeek Harness has no CLI agent id of its own; its filesystem skill provider scans the
  // cross-agent `<projectRoot>/.agents/skills` root the CLI's `universal` identity writes.
  'dsh-acp': 'universal',
  'kiro-cli': 'kiro-cli',
  'qoder-cli': 'qoder',
  'qoder-cli-cn': 'qoder-cn'
})

/** Resolve only declared or audited capability. `null` explicitly disables an
 * otherwise-known runtime id for an operator override. */
export function skillsAgentIdForRuntime(
  runtimeId: string,
  runtime?: Pick<RuntimeDef, 'skillsAgentId'>
): string | undefined {
  if (runtime && Object.prototype.hasOwnProperty.call(runtime, 'skillsAgentId')) {
    return runtime.skillsAgentId ?? undefined
  }
  return AUDITED_RUNTIME_SKILLS_AGENTS[runtimeId]
}
