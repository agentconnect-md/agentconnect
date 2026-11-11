// The agent's own cron tools (agent-cron-tools-v1): what each call sends the CP, and where they are offered.
import type { AgentCronReq, AgentCronResult } from '@agentconnect.md/protocol'
import { describe, expect, it } from 'vitest'
import { executeTool, type OpsDeps } from '../src/mcp/ops.js'
import { agentCronToolsFor } from '../src/mcp/ops/agent-crons.js'
import type { SessionContext } from '../src/mcp/ops/context.js'
import { checkCoordinate, gettingToKnowCoordinate } from '../src/session/subsession-coordinate.js'

const AGENT = '3c4d5e6f-7081-4293-a4b5-c6d7e8f90a1b'
const INTEGRATION = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const CRON = '7f3a1c56-8a2b-4c3d-9e4f-0a1b2c3d4e5f'

const slack = {
  agentId: AGENT,
  platform: 'slack',
  integrationId: INTEGRATION,
  channel: 'C1',
  thread: '1.1',
  isDm: false,
  tools: []
} as unknown as SessionContext
const webchat = { ...slack, platform: 'webchat', integrationId: undefined } as unknown as SessionContext

function harness(result: AgentCronResult = { status: 'ok' }) {
  const sent: AgentCronReq[] = []
  const deps = {
    gatewayFor: () => undefined,
    agentCrons: {
      offered: (ctx: SessionContext) => ctx.thread !== 'off',
      call: async (_ctx: SessionContext, req: AgentCronReq) => {
        sent.push(req)
        return result
      }
    }
  } as unknown as OpsDeps
  return { sent, deps }
}

describe('the agent cron tools', () => {
  it('are offered toward a CP that serves them, never in a check or a getting-to-know task', () => {
    expect(agentCronToolsFor(true, { thread: '1.1' }).map((t) => t.name)).toEqual([
      'listSchedules',
      'saveSchedule',
      'deleteSchedule'
    ])
    expect(agentCronToolsFor(false, { thread: '1.1' })).toEqual([])
    expect(agentCronToolsFor(true, { thread: checkCoordinate('d-1') })).toEqual([])
    expect(agentCronToolsFor(true, { thread: gettingToKnowCoordinate('d-2') })).toEqual([])
  })

  it('creates a recurring task that posts into this conversation by default', async () => {
    const { sent, deps } = harness()
    await executeTool(
      slack,
      'saveSchedule',
      { schedule: '0 9 * * MON-FRI', timezone: 'Asia/Shanghai', prompt: 'post the standup digest', name: 'standup' },
      deps
    )
    expect(sent).toEqual([
      {
        op: 'save',
        agentId: AGENT,
        cron: {
          name: 'standup',
          schedule: '0 9 * * MON-FRI',
          timezone: 'Asia/Shanghai',
          trigger: 'post the standup digest',
          target: { integrationId: INTEGRATION, channel: 'C1' }
        }
      }
    ])
  })

  it('creates a one-shot task headless where there is no chat integration', async () => {
    const { sent, deps } = harness()
    await executeTool(
      webchat,
      'saveSchedule',
      { runAt: '2026-11-12T09:00:00+08:00', timezone: 'Asia/Shanghai', prompt: 'check the deploy' },
      deps
    )
    expect(sent[0]).toMatchObject({ op: 'save', cron: { runAt: '2026-11-12T09:00:00+08:00', target: null } })
    await expect(
      executeTool(
        webchat,
        'saveSchedule',
        { runAt: '2026-11-12T09:00:00+08:00', timezone: 'UTC', prompt: 'x', postHere: true },
        deps
      )
    ).rejects.toThrow(/no chat integration/)
  })

  it('keeps an edited task where it posts unless told otherwise', async () => {
    const { sent, deps } = harness()
    await executeTool(
      slack,
      'saveSchedule',
      { cronId: CRON, schedule: '0 10 * * *', timezone: 'UTC', prompt: 'p' },
      deps
    )
    await executeTool(
      slack,
      'saveSchedule',
      { cronId: CRON, schedule: '0 10 * * *', timezone: 'UTC', prompt: 'p', postHere: false },
      deps
    )
    expect('target' in (sent[0] as { cron: object }).cron).toBe(false)
    expect(sent[1]).toMatchObject({ cron: { cronId: CRON, target: null } })
  })

  it('needs exactly one of schedule or runAt, and runAt with an offset', async () => {
    const { sent, deps } = harness()
    await expect(executeTool(slack, 'saveSchedule', { timezone: 'UTC', prompt: 'p' }, deps)).rejects.toThrow(
      /exactly one/
    )
    await expect(
      executeTool(
        slack,
        'saveSchedule',
        { schedule: '* * * * *', runAt: '2026-11-12T09:00:00Z', timezone: 'UTC', prompt: 'p' },
        deps
      )
    ).rejects.toThrow(/exactly one/)
    await expect(
      executeTool(slack, 'saveSchedule', { runAt: '2026-11-12T09:00:00', timezone: 'UTC', prompt: 'p' }, deps)
    ).rejects.toThrow(/offset/)
    expect(sent).toEqual([])
  })

  it("surfaces the CP's refusal and refuses a session that is not offered them", async () => {
    const { deps } = harness({ status: 'refused', message: 'no cron with that id is bound to you' })
    await expect(executeTool(slack, 'deleteSchedule', { cronId: CRON }, deps)).rejects.toThrow(/not bound|bound to you/)
    await expect(executeTool({ ...slack, thread: 'off' } as SessionContext, 'listSchedules', {}, deps)).rejects.toThrow(
      /not available/
    )
  })

  it('lists and deletes by the agent of the session', async () => {
    const { sent, deps } = harness({ status: 'ok', crons: [] })
    expect(await executeTool(slack, 'listSchedules', {}, deps)).toBeDefined()
    await executeTool(slack, 'deleteSchedule', { cronId: CRON }, deps)
    expect(sent).toEqual([
      { op: 'list', agentId: AGENT },
      { op: 'delete', agentId: AGENT, cronId: CRON }
    ])
  })
})
