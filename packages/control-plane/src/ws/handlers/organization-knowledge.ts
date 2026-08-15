import {
  isFrame,
  ORGANIZATION_KNOWLEDGE_FEATURE,
  ORGANIZATION_SUGGESTION_REVIEW_FEATURE
} from '@agentconnect.md/protocol'
import { AgentId, DaemonId, OrgId } from '../../domain/ids.js'
import { PLACEMENT_ONLY } from '../../orchestrator/placementResolver.js'
import type { DaemonView } from '../../ports.js'
import type { Handler } from './index.js'

async function featureDaemon(
  frameId: string,
  conn: Parameters<Handler>[1],
  deps: Parameters<Handler>[2]
): Promise<DaemonView | null> {
  // Daemon trust domain: the connection's own daemon (org-scoped-data-layer.md §4).
  const daemon = await deps.registry.getUnscoped(DaemonId(conn.daemonId))
  if (!daemon || !daemon.capabilities.features.includes(ORGANIZATION_KNOWLEDGE_FEATURE)) {
    conn.sendError(frameId, 'SCOPE_DENIED', 'daemon did not advertise organization knowledge support', false)
    return null
  }
  return daemon
}

function clampUtf8(text: string, maxBytes: number): { content: string; truncated: boolean; bytes: number } {
  const source = Buffer.from(text, 'utf8')
  if (source.byteLength <= maxBytes) return { content: text, truncated: false, bytes: source.byteLength }
  let end = Math.max(0, maxBytes)
  while (end > 0 && (source[end]! & 0xc0) === 0x80) end -= 1
  const content = source.subarray(0, end).toString('utf8')
  return { content, truncated: true, bytes: Buffer.byteLength(content) }
}

/** The requester an organization read may be served for: in the frame's org, and served by this
 *  connection right now. Authority is the live seam — placement PLUS the duty leases this member
 *  holds — because a pool agent names no machine and `agent.daemonId` would refuse every read from
 *  the very member running it. */
async function servingRequester(
  requesterAgentId: string,
  frameOrgId: string | undefined,
  daemon: DaemonView,
  conn: Parameters<Handler>[1],
  deps: Parameters<Handler>[2]
) {
  const requester = await deps.agent.getUnscoped(AgentId(requesterAgentId))
  const orgId = frameOrgId ? OrgId(frameOrgId) : daemon.orgId
  if (!requester || !orgId || requester.orgId !== orgId) return null
  const resolver = deps.placementResolver ?? PLACEMENT_ONLY
  return (await resolver.mayAct(requester, conn.daemonId)) ? requester : null
}

/** On-demand search. Organization membership is derived from the served
 * requester, never from daemon-supplied org input. */
export const handleKnowledgeSearch: Handler = async (frame, conn, deps) => {
  if (!isFrame('knowledge/search')(frame)) return
  const daemon = await featureDaemon(frame.id, conn, deps)
  if (!daemon) return
  const repo = deps.organizationKnowledge
  if (!repo) {
    conn.sendError(frame.id, 'INTERNAL', 'organization knowledge is unavailable', true)
    return
  }
  const requester = await servingRequester(frame.payload.requesterAgentId, frame.orgId, daemon, conn, deps)
  if (!requester) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'requesting agent is not served by this daemon', false)
    return
  }

  const rows = await repo.searchKnowledge(requester.orgId, {
    query: frame.payload.query,
    ...(frame.payload.tags !== undefined ? { tags: frame.payload.tags } : {}),
    limit: frame.payload.limit
  })
  let remaining = frame.payload.maxBytes
  const items = []
  for (const row of rows) {
    if (remaining <= 0) break
    const body = clampUtf8(row.content, remaining)
    remaining -= body.bytes
    items.push({
      id: row.id,
      title: row.title,
      summary: row.summary,
      tags: row.tags,
      revision: row.currentRevision,
      updatedAt: row.updatedAt.toISOString(),
      content: body.content,
      truncated: body.truncated
    })
  }
  conn.replyTo(frame, 'knowledge/search/ok', { items })
}

/** List recent org knowledge (query-less) the requester's org can see — the
 * browse companion to search, so a dreamer can enumerate what already exists
 * before proposing new. Org scope comes from the served requester. */
export const handleKnowledgeList: Handler = async (frame, conn, deps) => {
  if (!isFrame('knowledge/list')(frame)) return
  const daemon = await featureDaemon(frame.id, conn, deps)
  if (!daemon) return
  const repo = deps.organizationKnowledge
  if (!repo) {
    conn.sendError(frame.id, 'INTERNAL', 'organization knowledge is unavailable', true)
    return
  }
  const requester = await servingRequester(frame.payload.requesterAgentId, frame.orgId, daemon, conn, deps)
  if (!requester) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'requesting agent is not served by this daemon', false)
    return
  }
  const tags = frame.payload.tags
  const rows = (await repo.listKnowledge(requester.orgId, false))
    .filter((row) => tags === undefined || tags.every((t) => row.tags.includes(t)))
    .slice(0, frame.payload.limit)
  let remaining = frame.payload.maxBytes
  const items = []
  for (const row of rows) {
    if (remaining <= 0) break
    const body = clampUtf8(row.content, remaining)
    remaining -= body.bytes
    items.push({
      id: row.id,
      title: row.title,
      summary: row.summary,
      tags: row.tags,
      revision: row.currentRevision,
      updatedAt: row.updatedAt.toISOString(),
      content: body.content,
      truncated: body.truncated
    })
  }
  conn.replyTo(frame, 'knowledge/list/ok', { items })
}

/** List or search accepted organization skills (metadata only) the requester's
 * org can see, so a dreamer can enumerate existing skills and choose
 * update-vs-create. `query` filters by name/description; absent ⇒ list. */
export const handleOrgSkills: Handler = async (frame, conn, deps) => {
  if (!isFrame('skills/org')(frame)) return
  const daemon = await featureDaemon(frame.id, conn, deps)
  if (!daemon) return
  const repo = deps.organizationKnowledge
  if (!repo) {
    conn.sendError(frame.id, 'INTERNAL', 'organization skills are unavailable', true)
    return
  }
  const requester = await servingRequester(frame.payload.requesterAgentId, frame.orgId, daemon, conn, deps)
  if (!requester) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'requesting agent is not served by this daemon', false)
    return
  }
  const q = frame.payload.query?.toLowerCase()
  const rows = (await repo.listManagedSkills(requester.orgId, false))
    .filter((s) => q === undefined || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
    .slice(0, frame.payload.limit)
  conn.replyTo(frame, 'skills/org/ok', {
    items: rows.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      revision: s.currentRevision,
      updatedAt: s.updatedAt.toISOString()
    }))
  })
}

/** Reconnect/completion inventory upsert. Only agents this member currently SERVES may
 * publish metadata; CP review state stays authoritative. */
export const handleOrganizationSuggestionsSync: Handler = async (frame, conn, deps) => {
  if (!isFrame('knowledge/suggestions/sync')(frame)) return
  const daemon = await featureDaemon(frame.id, conn, deps)
  if (!daemon) return
  const orgId = frame.orgId ? OrgId(frame.orgId) : daemon.orgId
  if (!orgId) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'organization is required', false)
    return
  }
  const repo = deps.organizationKnowledge
  if (!repo) {
    conn.sendError(frame.id, 'INTERNAL', 'organization knowledge is unavailable', true)
    return
  }
  // Authority is the live seam, never `agent.daemonId`: a pool agent names no machine, so
  // placement equality would silently empty the inventory of the very members that dream.
  const resolver = deps.placementResolver ?? PLACEMENT_ONLY
  const claimed = new Set(
    frame.payload.suggestions
      .filter((suggestion) => suggestion.state === 'proposed')
      .map((suggestion) => suggestion.sourceAgentId)
  )
  const allowed = new Set<string>()
  for (const agent of await deps.agent.list(orgId)) {
    if (!claimed.has(String(agent.id))) continue
    if (await resolver.mayAct(agent, conn.daemonId)) allowed.add(String(agent.id))
  }
  const proposed = frame.payload.suggestions.filter(
    (suggestion) => suggestion.state === 'proposed' && allowed.has(suggestion.sourceAgentId)
  )
  const records = await repo.syncSuggestions(orgId, conn.daemonId, proposed)
  conn.replyTo(frame, 'knowledge/suggestions/sync/ok', {
    decisions: daemon.capabilities.features.includes(ORGANIZATION_SUGGESTION_REVIEW_FEATURE)
      ? records
          .filter((row) => row.state !== 'pending')
          .map((row) => ({
            sourceAgentId: row.sourceAgentId,
            dreamId: row.dreamId,
            candidateId: row.candidateId,
            state: row.state as 'accepted' | 'rejected'
          }))
      : []
  })
}

/** Download one immutable ZIP revision only for an agent that explicitly has
 * the managed skill enabled. */
export const handleManagedSkillRead: Handler = async (frame, conn, deps) => {
  if (!isFrame('managed-skill/read')(frame)) return
  const daemon = await featureDaemon(frame.id, conn, deps)
  if (!daemon) return
  const repo = deps.organizationKnowledge
  if (!repo) {
    conn.sendError(frame.id, 'INTERNAL', 'managed skills are unavailable', true)
    return
  }
  const requester = await servingRequester(frame.payload.requesterAgentId, frame.orgId, daemon, conn, deps)
  if (!requester || !requester.managedSkills.includes(frame.payload.managedSkillId)) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'managed skill is not enabled for this agent', false)
    return
  }
  // The managed-skill id comes from the daemon's frame, so it is fenced on the REQUESTER's org —
  // the one thing this handler has already proved (this connection serves the agent). The revision
  // fences through that parent (§3.6).
  const skill = await repo.getManagedSkill(requester.orgId, frame.payload.managedSkillId)
  const revision = await repo.getManagedSkillRevision(frame.payload.managedSkillId, frame.payload.revision)
  if (!skill || skill.archivedAt !== null || !revision) {
    conn.sendError(frame.id, 'BAD_PAYLOAD', 'managed skill revision not found', false)
    return
  }
  if (frame.payload.offset > revision.archive.byteLength) {
    conn.sendError(frame.id, 'BAD_PAYLOAD', 'managed skill offset exceeds archive size', false)
    return
  }
  const end = Math.min(revision.archive.byteLength, frame.payload.offset + frame.payload.limit)
  const data = revision.archive.subarray(frame.payload.offset, end)
  conn.replyTo(frame, 'managed-skill/chunk', {
    managedSkillId: frame.payload.managedSkillId,
    revision: frame.payload.revision,
    digest: revision.digest,
    size: revision.archive.byteLength,
    offset: frame.payload.offset,
    nextOffset: end,
    data: Buffer.from(data).toString('base64'),
    truncated: end < revision.archive.byteLength
  })
}
