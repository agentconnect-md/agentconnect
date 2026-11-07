// Every host's effect tools (gitlab-com-integration.md §14.2): core reads a host's family here and never names a host.
import type { CodeHostProvider } from '@agentconnect.md/protocol'
import type { ToolDescriptor } from '../tool-schema/descriptor.js'
import type { CodeHostEffectTool } from '../mcp/ops/code-host.js'
import { GITHUB_EFFECT_TOOLS } from '../github/effect-tools.js'
import { GITLAB_EFFECT_TOOLS } from '../gitlab/effect-tools.js'
import { GITEA_EFFECT_TOOLS } from '../gitea/effect-tools.js'
import { AZURE_DEVOPS_EFFECT_TOOLS } from '../azure-devops/effect-tools.js'

/** Every host's tools; a name belongs to exactly one host. */
export const CODE_HOST_EFFECT_TOOLS: readonly CodeHostEffectTool[] = [
  ...GITHUB_EFFECT_TOOLS,
  ...GITLAB_EFFECT_TOOLS,
  ...GITEA_EFFECT_TOOLS,
  ...AZURE_DEVOPS_EFFECT_TOOLS
]

/** The descriptors a session on this host's repository is offered. */
export function codeHostEffectToolsFor(provider: CodeHostProvider): ToolDescriptor[] {
  return CODE_HOST_EFFECT_TOOLS.filter((tool) => tool.provider === provider).map((tool) => tool.descriptor)
}

/** The session guidance the offered tools carry, one line each; undefined when none is offered. */
export function codeHostEffectGuidance(tools: readonly ToolDescriptor[]): string | undefined {
  const offered = new Set(tools.map((tool) => tool.name))
  const lines = CODE_HOST_EFFECT_TOOLS.filter((tool) => tool.guidance && offered.has(tool.descriptor.name)).map(
    (tool) => tool.guidance!
  )
  return lines.length > 0 ? lines.join('\n') : undefined
}

/** The read-only effect tools a follow-up check keeps (assistant-mode.md §5.12). */
export const CODE_HOST_EFFECT_READ_TOOL_NAMES: ReadonlySet<string> = new Set(
  CODE_HOST_EFFECT_TOOLS.filter((tool) => tool.readOnly).map((tool) => tool.descriptor.name)
)
