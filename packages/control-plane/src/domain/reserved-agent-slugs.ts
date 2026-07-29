/**
 * Agent slugs no user may take (preset-agents.md §3.3) — presets must not be
 * impersonable. Validated on `CreateAgentBody` (the slug is immutable, so
 * create-time is the only door); provisioning writes them through its own seam.
 * The M3 assistant names are reserved NOW so they cannot be squatted before it
 * ships. Existing rows are grandfathered.
 *
 * Lives in `domain/` so both the DTO layer and the persistence seam can import
 * it without crossing layers.
 */
export const RESERVED_AGENT_SLUGS: ReadonlySet<string> = new Set([
  'agentconnect',
  'agentconnect-assistant',
  'agent-assistant',
  'assistant'
])
