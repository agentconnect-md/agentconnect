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

// Only the conversation-owned admin host may populate this field; upstream metadata is never copied into it.
export const NativeMcpUi = z
  .object({
    resourceUri: z.literal(INTEGRATION_SETUP_URI),
    resourceVersion: z.literal(1),
    orgId: z.string().uuid(),
    intent: IntegrationSetupIntent
  })
  .strict()
export type NativeMcpUi = z.infer<typeof NativeMcpUi>

// Sent as `protocolVersion` in the `ui/initialize` result; the official SDK's `App.connect()` rejects a result without it (SEP-1865 Final).
export const MCP_APPS_PROTOCOL_VERSION = '2026-01-26'

// The most text one `ui/message` may carry into the conversation; matches the wire field's bound so a decoded list is clamped before it is refused.
export const MCP_APP_MESSAGE_MAX_CHARS = 4000

// The most model context one app may hold via `ui/update-model-context`; a note for the next turn carried on the session, not a store.
export const MCP_APP_CONTEXT_MAX_CHARS = 4000
