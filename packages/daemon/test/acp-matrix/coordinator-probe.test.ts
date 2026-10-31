import { describe, expect, it } from 'vitest'
import {
  CO_IDS,
  CO_SCENARIOS,
  coordinatorFixture,
  coordinatorPrompt,
  decide,
  judgeCoordinator,
  renderBatch,
  selectedCoordinatorScenarios,
  type CoRecordedCall,
  type CoScope
} from './coordinator-probe.js'

const scenario = (id: string) => CO_SCENARIOS.find((entry) => entry.id === id)!
const scopeOf = (id: string): CoScope => ({
  messages: scenario(id).messages.map((message) => message.id),
  reports: scenario(id)
    .messages.filter((message) => message.report)
    .map((message) => message.id),
  tasks: scenario(id).tasks
})
const recorded = (id: string, calls: Array<Record<string, unknown>>): CoRecordedCall[] => {
  const log: CoRecordedCall[] = []
  for (const args of calls) {
    const decided = new Set(log.flatMap((call) => (call.outcome ? [call.outcome.messageId] : [])))
    const verdict = decide(args, scopeOf(id), decided)
    log.push({ tool: 'sendMessage', args, ...verdict })
  }
  return log
}

describe('runtime matrix coordinator probe', () => {
  it('refuses calls that name no delivered message, an unknown task, or a decided message', () => {
    const scope = scopeOf('route-to-task')
    const [id] = scope.messages
    expect(decide({ action: 'delegateTask', messageId: 'nope', title: 't' }, scope, new Set())).toMatchObject({
      error: expect.stringContaining('not a message delivered')
    })
    expect(decide({ action: 'messageTask', messageId: id, taskId: 'task-x' }, scope, new Set())).toMatchObject({
      error: expect.stringContaining('not one of your open tasks')
    })
    expect(decide({ action: 'replyToMessage', messageId: id, message: 'hi' }, scope, new Set([id!]))).toMatchObject({
      error: expect.stringContaining('already has an outcome')
    })
    expect(decide({ action: 'delegateTask', messageId: id }, scope, new Set())).toHaveProperty('error')
  })

  it('passes a batch whose every message gets its expected outcome', () => {
    const [, work, , thanks] = scenario('batch-mixed').messages.map((message) => message.id)
    const calls = recorded('batch-mixed', [
      { action: 'delegateTask', messageId: work, title: 'Webhook retry' },
      { action: 'replyToMessage', messageId: thanks, message: 'Glad it helped!' }
    ])
    expect(judgeCoordinator(scenario('batch-mixed'), calls, 'AC_NO_RESPONSE').verdict).toBe('PASS')
  })

  it('fails an ignored mention, a wrong task, and a reply to chatter', () => {
    expect(judgeCoordinator(scenario('greeting'), [], 'AC_NO_RESPONSE').verdict).toBe('FAIL')
    const [chatter] = scopeOf('ignore-chatter').messages
    const reply = recorded('ignore-chatter', [{ action: 'replyToMessage', messageId: chatter, message: 'sure' }])
    expect(judgeCoordinator(scenario('ignore-chatter'), reply, '').verdict).toBe('FAIL')
    expect(judgeCoordinator(scenario('ignore-chatter'), [], 'Sounds fun').verdict).toBe('FAIL')
  })

  it('counts a single-message turn text as its reply and an alternative as degraded', () => {
    expect(judgeCoordinator(scenario('greeting'), [], 'Good morning!').verdict).toBe('PASS')
    const [status] = scopeOf('status-reply').messages
    const routed = recorded('status-reply', [{ action: 'messageTask', messageId: status, taskId: CO_IDS.checkoutTask }])
    expect(judgeCoordinator(scenario('status-reply'), routed, '').verdict).toBe('DEGRADED')
    const vague = recorded('status-reply', [{ action: 'replyToMessage', messageId: status, message: 'In review.' }])
    expect(judgeCoordinator(scenario('status-reply'), vague, '')).toMatchObject({ verdict: 'DEGRADED' })
  })

  it('degrades a corrected refusal and serves the tools over HTTP MCP', async () => {
    const [id] = scopeOf('new-work').messages
    const calls = recorded('new-work', [
      { action: 'delegateTask', messageId: id },
      { action: 'delegateTask', messageId: id, title: 'Staging ImagePullBackOff' }
    ])
    expect(judgeCoordinator(scenario('new-work'), calls, '').verdict).toBe('DEGRADED')
    const fixture = await coordinatorFixture()
    try {
      const { url } = fixture.descriptor('k', scopeOf('route-to-task')) as { url: string }
      const post = (body: unknown) =>
        fetch(url, { method: 'POST', body: JSON.stringify(body) }).then((res) => res.json() as Promise<any>)
      const listed = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['sendMessage', 'listTasks'])
      const tasks = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'listTasks' } })
      expect(tasks.result.content[0].text).toContain(CO_IDS.checkoutTask)
      expect(fixture.calls('k').map((call) => call.tool)).toEqual(['listTasks'])
    } finally {
      fixture.server.close()
    }
  })

  it('takes only a reply for a report, and passes one that names what it reported', () => {
    const [report] = scopeOf('report-reply').messages
    expect(
      decide({ action: 'delegateTask', messageId: report, title: 'PR' }, scopeOf('report-reply'), new Set())
    ).toMatchObject({ error: expect.stringContaining('is a report') })
    const told = recorded('report-reply', [
      { action: 'replyToMessage', messageId: report, message: '<@U0EXAMPLE1> PR #4821 merged and main is green.' }
    ])
    expect(judgeCoordinator(scenario('report-reply'), told, 'AC_NO_RESPONSE').verdict).toBe('PASS')
    expect(judgeCoordinator(scenario('report-reply'), [], 'AC_NO_RESPONSE').verdict).toBe('FAIL')
    expect(renderBatch(scenario('report-reply').messages)).toContain('<report id="msg-1700001100.000100">')
  })

  // auto-session-mode.md §10: a webchat person reads the turn's text, so text beside a call is degraded there and nowhere else.
  it('probes the webchat prompt, where text beside a call is shown', () => {
    const [id] = scopeOf('webchat-new-work').messages
    const delegated = recorded('webchat-new-work', [
      { action: 'delegateTask', messageId: id, title: 'Webhook retries' }
    ])
    expect(judgeCoordinator(scenario('webchat-new-work'), delegated, 'AC_NO_RESPONSE').verdict).toBe('PASS')
    expect(judgeCoordinator(scenario('webchat-new-work'), delegated, 'On it!')).toMatchObject({
      verdict: 'DEGRADED',
      notes: [expect.stringContaining('text shown beside a call')]
    })
    const [channel] = scopeOf('new-work').messages
    const quiet = recorded('new-work', [{ action: 'delegateTask', messageId: channel, title: 'Staging pulls' }])
    expect(judgeCoordinator(scenario('new-work'), quiet, 'On it!').verdict).toBe('PASS')
    expect(judgeCoordinator(scenario('webchat-status'), [], 'PR #4821 is in review.').verdict).toBe('PASS')
    expect(renderBatch(scenario('webchat-status').messages, true)).toContain(
      `[One new message in this conversation (${CO_IDS.conversation})]`
    )
    expect(coordinatorPrompt(true)).toContain('in a private webchat conversation')
  })

  it('renders ids and mentions, and rejects unknown scenario ids', () => {
    const batch = renderBatch(scenario('batch-mixed').messages)
    expect(batch).toContain('4 new channel-root messages')
    expect(batch).toContain('mentions-you="yes"')
    expect(coordinatorPrompt()).toContain('AC_NO_RESPONSE')
    expect(() => selectedCoordinatorScenarios('nope')).toThrow(/unknown coordinator scenario/)
    expect(selectedCoordinatorScenarios('greeting').map((entry) => entry.id)).toEqual(['greeting'])
  })
})
