/**
 * Agent slugs no user may take (preset-agents.md §3.3) — built-ins must not be
 * impersonable. Validated on `CreateAgentBody` (the slug is immutable, so
 * create-time is the only door); provisioning writes them through its own seam.
 * Only the shipped preset's own slug is reserved (2026-07-29): the assistant
 * names were released once the dedicated assistant was cancelled — its
 * capabilities fold into THIS agent, so no future built-in claims them.
 * Existing rows are grandfathered.
 *
 * Lives in `domain/` so both the DTO layer and the persistence seam can import
 * it without crossing layers.
 */
export const RESERVED_AGENT_SLUGS: ReadonlySet<string> = new Set(['agentconnect'])
