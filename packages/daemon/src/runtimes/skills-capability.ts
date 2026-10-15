import type { RuntimeDef } from '../config/config-schema.js'

// Identities verified with the bundled skills CLI and native discovery; the CLI owns destination paths.
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
  // DeepSeek and Muse discover the project .agents/skills directory written by the universal identity.
  'dsh-acp': 'universal',
  'muse-acp': 'universal',
  'kiro-cli': 'kiro-cli',
  // skills@1.5.21 `openclaw` identity — global ~/.openclaw/skills, project `skills/`.
  openclaw: 'openclaw',
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
