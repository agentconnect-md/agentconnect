// ⚠️ NO RELATIVE IMPORTS — a bundler compiles this from source; web's protocol-imports.leaf.test.ts enforces it.
import { z } from 'zod'

export const INTEGRATION_SETUP_URI = 'ui://agentconnect/integration-setup'
export const IntegrationSetupIntent = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('create'),
      provider: z.string().min(1).max(64).optional(),
      agentId: z.string().uuid().optional()
    })
    .strict(),
  z
    .object({
      mode: z.literal('edit'),
      agentId: z.string().uuid(),
      target: z.object({ kind: z.enum(['integration', 'codehost-subscription']), id: z.string().uuid() }).strict()
    })
    .strict()
])
export type IntegrationSetupIntent = z.infer<typeof IntegrationSetupIntent>

export const CODE_HOST_SETUP_URI = 'ui://agentconnect/code-host-setup'
// Redeclared rather than imported from `./code-host`: this module is a leaf (see the banner).
export const CODE_HOST_SETUP_PROVIDERS = ['github', 'gitlab', 'gitea'] as const
// Which card the connection surface opens on; omitted means the whole surface, as the Console page shows it.
export const CodeHostSetupIntent = z.object({ provider: z.enum(CODE_HOST_SETUP_PROVIDERS).optional() }).strict()
export type CodeHostSetupIntent = z.infer<typeof CodeHostSetupIntent>

export const AGENT_SETUP_URI = 'ui://agentconnect/agent-setup'
// The groups of the Console agent editor; omitted opens on its first one.
export const AGENT_SETUP_SECTIONS = ['basics', 'runtime', 'access', 'secrets'] as const
export const AgentSetupIntent = z
  .object({
    agentId: z.string().uuid(),
    section: z.enum(AGENT_SETUP_SECTIONS).optional(),
    // Set by `createAgent`, whose card is the new agent's own next step rather than an edit of an old one.
    created: z.boolean().optional()
  })
  .strict()
export type AgentSetupIntent = z.infer<typeof AgentSetupIntent>

export const SKILL_SETUP_URI = 'ui://agentconnect/skill-setup'
// `registry` searches skills.sh by name; `git` imports a repository. Omitted takes the registry.
export const SKILL_SETUP_SOURCES = ['registry', 'git'] as const
export const SkillSetupIntent = z
  .object({
    source: z.enum(SKILL_SETUP_SOURCES).optional(),
    query: z.string().min(1).max(200).optional(),
    agentId: z.string().uuid().optional()
  })
  .strict()
export type SkillSetupIntent = z.infer<typeof SkillSetupIntent>

export const MCP_SETUP_URI = 'ui://agentconnect/mcp-setup'
// A server's url, headers and OAuth credential are typed in the dialog, never carried in an intent.
export const McpSetupIntent = z.object({ agentId: z.string().uuid().optional() }).strict()
export type McpSetupIntent = z.infer<typeof McpSetupIntent>

const nativeApp = <U extends string, I extends z.ZodTypeAny>(uri: U, intent: I) =>
  z
    .object({
      resourceUri: z.literal(uri),
      resourceVersion: z.literal(1),
      orgId: z.string().min(1).max(200),
      intent
    })
    .strict()

// A bounded presentation request; Console JWT authorization governs every form read and write.
export const NativeMcpUi = z.discriminatedUnion('resourceUri', [
  nativeApp(INTEGRATION_SETUP_URI, IntegrationSetupIntent),
  nativeApp(CODE_HOST_SETUP_URI, CodeHostSetupIntent),
  nativeApp(AGENT_SETUP_URI, AgentSetupIntent),
  nativeApp(SKILL_SETUP_URI, SkillSetupIntent),
  nativeApp(MCP_SETUP_URI, McpSetupIntent)
])
export type NativeMcpUi = z.infer<typeof NativeMcpUi>

// A write tool's own answer stays its answer; the card it earns rides alongside it under this key.
export const NativeUiEnvelope = z.object({ nativeUi: NativeMcpUi }).loose()

/** The heading one intent earns, decided by the resource — the daemon's card chrome and the Console card must not word it differently. */
export function nativeUiTitle(ui: NativeMcpUi): string {
  switch (ui.resourceUri) {
    case CODE_HOST_SETUP_URI:
      return 'Code host connections'
    case AGENT_SETUP_URI:
      return ui.intent.created ? 'Agent created' : 'Edit agent'
    case SKILL_SETUP_URI:
      return 'Install skill'
    case MCP_SETUP_URI:
      return 'Add MCP server'
    default:
      return ui.intent.mode === 'edit' ? 'Edit integration' : 'Add integration'
  }
}

// Sent as `protocolVersion` in the `ui/initialize` result; the official SDK's `App.connect()` rejects a result without it (SEP-1865 Final).
export const MCP_APPS_PROTOCOL_VERSION = '2026-01-26'

// The most text one `ui/message` may carry into the conversation; matches the wire field's bound so a decoded list is clamped before it is refused.
export const MCP_APP_MESSAGE_MAX_CHARS = 4000

// The most model context one app may hold via `ui/update-model-context`; a note for the next turn carried on the session, not a store.
export const MCP_APP_CONTEXT_MAX_CHARS = 4000
