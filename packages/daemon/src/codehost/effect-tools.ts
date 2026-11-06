// Every host's effect tools (gitlab-com-integration.md §14.2): core reads a host's family here and never names a host.
import type { CodeHostProvider } from '@agentconnect.md/protocol'
import type { ToolDescriptor } from '../tool-schema/descriptor.js'
import type { CodeHostEffectTool } from '../mcp/ops/code-host.js'
import { GITLAB_EFFECT_TOOLS } from '../gitlab/effect-tools.js'
import { GITEA_EFFECT_TOOLS } from '../gitea/effect-tools.js'

/** Every host's tools; a name belongs to exactly one host. */
export const CODE_HOST_EFFECT_TOOLS: readonly CodeHostEffectTool[] = [...GITLAB_EFFECT_TOOLS, ...GITEA_EFFECT_TOOLS]

/** The descriptors a session on this host's repository is offered. */
export function codeHostEffectToolsFor(provider: CodeHostProvider): ToolDescriptor[] {
  return CODE_HOST_EFFECT_TOOLS.filter((tool) => tool.provider === provider).map((tool) => tool.descriptor)
}

/** The read-only effect tools a follow-up check keeps (assistant-mode.md §5.12). */
export const CODE_HOST_EFFECT_READ_TOOL_NAMES: ReadonlySet<string> = new Set(
  CODE_HOST_EFFECT_TOOLS.filter((tool) => tool.readOnly).map((tool) => tool.descriptor.name)
)
