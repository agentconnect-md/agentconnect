// Who sees an agent's place layer in the console: whoever the console shows a session of that conversation (product-conventions.md "Memory layers").
import type { FastifyRequest } from 'fastify'
import type { MemoryChannelEntry } from '@agentconnect.md/protocol'
import { AgentId } from '../domain/ids.js'
import type { SessionConversationRecord, SessionFilterQuery } from '../persistence/ports.js'
import type { HttpDeps } from './deps.js'
import { ctxOf, orgOf } from './rbac.js'
import { makeSessionAccessResolver } from './session-access.js'

/** One place layer as the caller may know it. */
export interface PlaceLayerView {
  channelKey: string
  channel: string | null
  transportScope: string | null
  platform: string | null
  name: string | null
  /** The caller can see a session of the layer's conversation, so may read and change the layer. */
  visible: boolean
}

export interface MemoryPlaceAccess {
  /** Every layer judged for the caller; the ones they may not see are kept only when `withHidden`. */
  judge(
    req: FastifyRequest,
    agentId: string,
    entries: readonly MemoryChannelEntry[],
    withHidden: boolean
  ): Promise<PlaceLayerView[]>
}

const matches = (rows: readonly SessionConversationRecord[], entry: MemoryChannelEntry) =>
  rows.find((row) => row.channel === entry.channel && (!entry.platform || row.platform === entry.platform))

export function makeMemoryPlaceAccess(deps: HttpDeps): MemoryPlaceAccess {
  const sessionAccess = makeSessionAccessResolver(deps)
  return {
    async judge(req, agentId, entries, withHidden) {
      const channels = [...new Set(entries.flatMap((entry) => (entry.channel ? [entry.channel] : [])))]
      const query: SessionFilterQuery = { agentIds: [AgentId(agentId)] }
      // The same predicate the console's session list applies: the caller's identities, linked ones and permission sync included.
      let seen: SessionConversationRecord[] = []
      if (channels.length > 0) {
        const access = await sessionAccess.forQuery(req, query)
        const viewer = {
          role: ctxOf(req).role,
          identitySet: [...access.identitySet],
          externalAccess: access.externalAccess
        }
        seen = await deps.repos.session.conversationsIn({ ...query, viewer }, channels)
      }
      // A hidden layer is named from every session there: only an owner, who may clear it, is shown one.
      const every = withHidden && channels.length > 0 ? await deps.repos.session.conversationsIn(query, channels) : []
      const views = entries.flatMap((entry): PlaceLayerView[] => {
        const visibleRow = entry.channel ? matches(seen, entry) : undefined
        if (!visibleRow && !withHidden) return []
        const row = visibleRow ?? (entry.channel ? matches(every, entry) : undefined)
        return [
          {
            channelKey: entry.channelKey,
            channel: entry.channel ?? null,
            transportScope: entry.transportScope ?? null,
            platform: entry.platform ?? row?.platform ?? null,
            name: entry.name ?? row?.channelName ?? null,
            visible: visibleRow !== undefined
          }
        ]
      })
      // A layer no session names yet takes its name from the organization's channel directory, as the session list does.
      const unnamed = views.filter((view) => !view.name && view.channel && view.platform)
      if (unnamed.length === 0) return views
      const directory = await deps.repos.integrationChannel.namesForOrg(
        orgOf(req),
        unnamed.map((view) => ({ platform: view.platform!, channelId: view.channel! }))
      )
      return views.map((view) => {
        if (view.name) return view
        const named = directory.find((row) => row.platform === view.platform && row.channelId === view.channel)
        return named ? { ...view, name: named.name } : view
      })
    }
  }
}
