import {
  buildEnvelope,
  decodeEnvelope,
  encode,
  DECISION_LIST_MAX_BYTES,
  type AgentModelSelection,
  type DecisionToolDefinition
} from '@agentconnect.md/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'
import { handleDecisionRead } from './decisions.js'

const agentId = '11111111-1111-4111-8111-111111111111'
const daemonId = '22222222-2222-4222-8222-222222222222'
const orgId = 'example-org'
const decision: DecisionToolDefinition = {
  id: '33333333-3333-4333-8333-333333333333',
  name: 'Reply',
  providerId: 'typesafe',
  model: 'jev-latest',
  question: { type: 'boolean', instructions: 'Should this receive a reply?', criteria: { true: 'Yes', false: 'No' } }
}

function setup() {
  const agent = vi.fn(
    async (): Promise<{
      id: string
      orgId: string
      daemonId: string
      decisionIds: string[]
      modelSelection?: AgentModelSelection
    }> => ({ id: agentId, orgId, daemonId, decisionIds: [decision.id] })
  )
  const listForAgent = vi.fn(async () => [decision])
  const getForAgent = vi.fn(async (): Promise<DecisionToolDefinition | null> => decision)
  const mayAct = vi.fn(async () => true)
  const conn = { daemonId, orgId: null, replyTo: vi.fn(), sendError: vi.fn() }
  const deps = { agent: { get: agent }, decision: { listForAgent, getForAgent }, placementResolver: { mayAct } }
  const run = async (type: 'decision/list' | 'decision/get', extra: Record<string, unknown> = {}) => {
    const decoded = decodeEnvelope(
      encode(
        buildEnvelope(
          type,
          {
            requesterAgentId: agentId,
            ...(type === 'decision/get' ? { decisionId: decision.id } : {}),
            ...extra
          },
          { orgId }
        )
      )
    )
    if (!decoded.ok) throw new Error(decoded.msg)
    await handleDecisionRead(decoded.frame, conn as unknown as DaemonConnection, deps as unknown as DaemonWsDeps)
  }
  return { agent, listForAgent, getForAgent, mayAct, conn, run }
}

describe('Decision configuration reads for agent tools', () => {
  it('separates the model-selection grant from MCP attachments and rechecks revocation', async () => {
    const { agent, getForAgent, conn, run } = setup()
    const bound = {
      id: agentId,
      orgId,
      daemonId,
      decisionIds: [],
      modelSelection: {
        decisionId: decision.id,
        rules: [{ when: { type: 'boolean' as const, values: [true] }, runtime: 'claude', model: 'model-a' }]
      }
    }
    agent.mockResolvedValue(bound)
    await run('decision/get')
    expect(getForAgent).not.toHaveBeenCalled()
    await run('decision/get', { purpose: 'model_selection' })
    expect(conn.replyTo).toHaveBeenLastCalledWith(expect.anything(), 'decision/get/result', { decision })
    agent.mockResolvedValue({ ...bound, modelSelection: undefined }).mockResolvedValueOnce(bound)
    await run('decision/get', { purpose: 'model_selection' })
    expect(conn.replyTo).toHaveBeenLastCalledWith(expect.anything(), 'decision/get/result', { decision: null })
  })
  it('scopes both reads to the frame organization and current serving daemon', async () => {
    const { agent, listForAgent, getForAgent, mayAct, conn, run } = setup()
    await run('decision/list')
    expect(listForAgent).toHaveBeenCalledWith(orgId, [decision.id], { requesterAgentId: agentId, limit: 10 })
    expect(conn.replyTo).toHaveBeenLastCalledWith(expect.anything(), 'decision/list/result', {
      items: [decision],
      nextCursor: null
    })
    await run('decision/get')
    expect(getForAgent).toHaveBeenCalledWith(orgId, decision.id)
    expect(conn.replyTo).toHaveBeenLastCalledWith(expect.anything(), 'decision/get/result', { decision })
    expect(agent).toHaveBeenCalledWith(orgId, agentId)
    expect(mayAct).toHaveBeenCalledWith(expect.objectContaining({ id: agentId, orgId, daemonId }), daemonId)
  })

  it('denies foreign agents and lost placement before reading any configuration', async () => {
    const { agent, mayAct, listForAgent, getForAgent, conn, run } = setup()
    agent.mockResolvedValueOnce(null as never)
    await run('decision/list')
    mayAct.mockResolvedValueOnce(false)
    await run('decision/get')
    expect(listForAgent).not.toHaveBeenCalled()
    expect(getForAgent).not.toHaveBeenCalled()
    expect(conn.replyTo).not.toHaveBeenCalled()
    expect(conn.sendError).toHaveBeenCalledTimes(2)
  })

  it.each(['decision/list', 'decision/get'] as const)('rechecks placement after a %s read', async (type) => {
    const { mayAct, conn, run } = setup()
    mayAct.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    await run(type)
    expect(conn.replyTo).not.toHaveBeenCalled()
    expect(conn.sendError).toHaveBeenCalledWith(expect.any(String), 'SCOPE_DENIED', expect.any(String), false)
  })

  it('keeps complete questions within the byte budget and returns a continuation cursor', async () => {
    const { agent, listForAgent, conn, run } = setup()
    const long = { ...decision, question: { ...decision.question, instructions: 'x'.repeat(16_000) } }
    const rows = Array.from({ length: 3 }, (_, i) => ({ ...long, id: `33333333-3333-4333-8333-33333333333${i}` }))
    agent.mockResolvedValue({ id: agentId, orgId, daemonId, decisionIds: rows.map((row) => row.id) })
    listForAgent.mockResolvedValueOnce(rows)
    await run('decision/list', { limit: 3 })
    const result = conn.replyTo.mock.calls[0]![2]
    expect(result.items.length).toBe(2)
    expect(result.items[0].question.instructions).toBe(long.question.instructions)
    expect(result.nextCursor).toBe(rows[1]!.id)
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(DECISION_LIST_MAX_BYTES)
    listForAgent.mockResolvedValueOnce(rows)
    await run('decision/list', { limit: 1 })
    expect(conn.replyTo.mock.calls[1]![2]).toEqual({ items: [rows[0]], nextCursor: rows[0]!.id })
  })

  it('refuses unbound IDs and retracts a definition when its binding is removed during the read', async () => {
    const { agent, getForAgent, conn, run } = setup()
    agent.mockResolvedValue({ id: agentId, orgId, daemonId, decisionIds: [] })
    await run('decision/get')
    expect(getForAgent).not.toHaveBeenCalled()
    expect(conn.replyTo).toHaveBeenLastCalledWith(expect.anything(), 'decision/get/result', { decision: null })
    agent.mockResolvedValueOnce({ id: agentId, orgId, daemonId, decisionIds: [decision.id] })
    await run('decision/get')
    expect(getForAgent).toHaveBeenCalledOnce()
    expect(conn.replyTo).toHaveBeenLastCalledWith(expect.anything(), 'decision/get/result', { decision: null })
  })
})
