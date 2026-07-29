/**
 * Agent slugs no user may take (preset-agents.md §3.3) — built-ins must not be
 * impersonable. Validated on `CreateAgentBody` (the slug is immutable, so
 * create-time is the only door); provisioning writes them through its own seam.
 * The assistant names stay reserved even though the DEDICATED assistant preset
 * was cancelled (its capabilities are planned to fold into the `agentconnect`
 * default agent) — reserving them keeps impersonation impossible and the naming
 * option open. Existing rows are grandfathered.
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
