// The Teams agent-bot request store's contract in memory: the claim one check holds, and the token each check replaces.
import type { MsTeamsAgentBotRequestRecord, MsTeamsAgentBotRequestStore } from '../../src/persistence/ports.js'

type Row = MsTeamsAgentBotRequestRecord & { claim?: string; claimedUntil?: number }

export function memoryMsTeamsAgentBotRequestStore(now: () => number): {
  rows: Map<string, Row>
  store: MsTeamsAgentBotRequestStore
} {
  const rows = new Map<string, Row>()
  const store: MsTeamsAgentBotRequestStore = {
    create: async (input) => {
      for (const [id, row] of rows)
        if (row.orgId === input.orgId && row.agentId === input.agentId && row.tenantId === input.tenantId)
          rows.delete(id)
      const row: Row = { ...input, status: 'pending', reason: null, checks: 0, createdAt: new Date(now()) }
      rows.set(input.id, row)
      return row
    },
    get: async (orgId, id) => {
      const row = rows.get(id)
      return row && row.orgId === orgId ? row : null
    },
    listForAgent: async (orgId, agentId) =>
      [...rows.values()].filter((row) => row.orgId === orgId && row.agentId === agentId),
    due: async (at) =>
      [...rows.values()]
        .filter((row) => row.status === 'pending' && row.nextCheckAt <= at)
        .map((row) => ({ orgId: row.orgId, id: row.id })),
    openedBefore: async (before) =>
      [...rows.values()].filter((row) => row.createdAt < before).map((row) => ({ orgId: row.orgId, id: row.id })),
    claim: async (_orgId, id, token, at, until) => {
      const row = rows.get(id)
      if (!row || (row.claimedUntil !== undefined && row.claimedUntil > at.getTime())) return false
      Object.assign(row, { claim: token, claimedUntil: until.getTime() })
      return true
    },
    holds: async (orgId, id, token) => {
      const row = rows.get(id)
      return !!row && row.orgId === orgId && row.claim === token
    },
    release: async (_orgId, id, token, patch) => {
      const row = rows.get(id)
      if (!row || row.claim !== token) return
      delete row.claim
      delete row.claimedUntil
      Object.assign(row, { checks: row.checks + 1, ...patch })
    },
    resume: async (_orgId, id, refreshToken, at) => {
      const row = rows.get(id)
      if (row) Object.assign(row, { refreshToken, status: 'pending', reason: null, checks: 0, nextCheckAt: at })
    },
    delete: async (_orgId, id) => void rows.delete(id)
  }
  return { rows, store }
}
