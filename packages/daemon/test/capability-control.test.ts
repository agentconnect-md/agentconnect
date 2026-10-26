// The C→D capability frames a daemon routes: `agent/mcp-rebound` reloads sessions and answers nothing (capability-requests.md §4.8).
import type { AgentMcpRebound, AnyFrame } from '@agentconnect.md/protocol'
import { describe, expect, it, vi } from 'vitest'
import { agentMcpRebound } from '../src/cp/control/capability.js'
import { CONTROL_HANDLERS } from '../src/cp/control/registry.js'
import type { ControlWire } from '../src/cp/control/context.js'

const AGENT = '3c4d5e6f-7081-4293-a4b5-c6d7e8f90a1b'

function wire(): ControlWire & { replies: unknown[] } {
  const replies: unknown[] = []
  return {
    replies,
    reply: (_req, type, payload) => void replies.push({ type, payload }),
    sendError: (corr, code) => void replies.push({ error: code, corr }),
    emit: () => undefined,
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never
  }
}

describe('agent/mcp-rebound', () => {
  it('is routed, hands the agent and server to the daemon, and answers nothing', async () => {
    expect(CONTROL_HANDLERS.get('agent/mcp-rebound')).toBe(agentMcpRebound)
    const seen: AgentMcpRebound[] = []
    const w = wire()
    const frame = { id: 'f-1', type: 'agent/mcp-rebound', payload: { agentId: AGENT, server: 'Linear' } }
    await agentMcpRebound(frame as unknown as AnyFrame, { mcpRebound: async (req) => void seen.push(req) }, w)
    await Promise.resolve()
    expect(seen).toEqual([{ agentId: AGENT, server: 'Linear' }])
    expect(w.replies).toEqual([])
  })

  it('logs a failed reload instead of answering', async () => {
    const w = wire()
    const frame = { id: 'f-2', type: 'agent/mcp-rebound', payload: { agentId: AGENT, server: 'Linear' } }
    await agentMcpRebound(
      frame as unknown as AnyFrame,
      {
        mcpRebound: async () => {
          throw new Error('store offline')
        }
      },
      w
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(w.replies).toEqual([])
    expect(w.log.warn).toHaveBeenCalledWith(expect.stringContaining('store offline'))
  })
})
