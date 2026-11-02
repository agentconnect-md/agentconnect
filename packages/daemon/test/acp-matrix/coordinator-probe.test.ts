import { describe, expect, it } from 'vitest'
import {
  boardFor,
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
  tasks: scenario(id).tasks,
  ...(scenario(id).elsewhere ? { elsewhere: scenario(id).elsewhere } : {}),
  ...(scenario(id).reads ? { reads: scenario(id).reads } : {})
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
      expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
        'sendMessage',
        'listTasks',
        'readTask'
      ])
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
    expect(renderBatch(scenario('report-reply').messages)).toContain(
      '<report id="msg-1700001100.000100" task="followup-pr-4821" kind="follow-up" title="Watch PR #4821">'
    )
  })

  // assistant-mode.md §5.18 ④: a batch of a message and two reports, one worth telling and one to leave.
  it('passes a report batch that relays the news, delegates the work and leaves the empty check', () => {
    const [news, work, quiet] = scopeOf('report-batch').messages
    const batch = renderBatch(scenario('report-batch').messages)
    expect(batch).toContain('[One new channel-root message and 2 reports in #eng-platform (C0EXAMPLE1)]')
    expect(batch.indexOf(news!)).toBeLessThan(batch.indexOf(work!))
    expect(batch.indexOf(work!)).toBeLessThan(batch.indexOf(quiet!))
    const told = [
      { action: 'replyToMessage', messageId: news, message: '<@U0EXAMPLE1> PR #4821 merged and main is green.' },
      { action: 'delegateTask', messageId: work, title: 'Nightly analytics export failure' }
    ]
    expect(judgeCoordinator(scenario('report-batch'), recorded('report-batch', told), 'AC_NO_RESPONSE').verdict).toBe(
      'PASS'
    )
    const noisy = recorded('report-batch', [
      ...told,
      { action: 'replyToMessage', messageId: quiet, message: 'The staging certificate is fine.' }
    ])
    expect(judgeCoordinator(scenario('report-batch'), noisy, 'AC_NO_RESPONSE').verdict).toBe('DEGRADED')
    const missed = recorded('report-batch', [told[1]!])
    expect(judgeCoordinator(scenario('report-batch'), missed, 'AC_NO_RESPONSE').verdict).toBe('FAIL')
  })

  // auto-session-mode.md §6.8: a run report from a task holding a code channel is relayed in the thread it was asked in.
  it('passes a channel task’s run report relayed with replyToMessage, and fails one left unsaid', () => {
    const [report] = scopeOf('channel-task-report').messages
    expect(renderBatch(scenario('channel-task-report').messages)).toContain(
      `<report id="${report}" task="${CO_IDS.retryTask}" kind="delegated task" ` +
        'title="Add retry with backoff to the webhook sender">'
    )
    const told = recorded('channel-task-report', [
      { action: 'replyToMessage', messageId: report, message: '<@U0EXAMPLE1> PR #4907 is ready for review.' }
    ])
    expect(judgeCoordinator(scenario('channel-task-report'), told, 'AC_NO_RESPONSE').verdict).toBe('PASS')
    expect(judgeCoordinator(scenario('channel-task-report'), [], 'AC_NO_RESPONSE').verdict).toBe('FAIL')
    const handed = recorded('channel-task-report', [
      { action: 'messageTask', messageId: report, taskId: CO_IDS.retryTask }
    ])
    expect(handed[0]).toMatchObject({ error: expect.stringContaining('is a report') })
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

  // assistant-mode.md §5.18: the coordinator opens with the work board and reads other places' tasks read only.
  it('opens with the work board, lists elsewhere apart, and fails a duplicate of work open elsewhere', async () => {
    expect(boardFor(scenario('new-work'))).toBeUndefined()
    expect(boardFor(scenario('route-to-task'))).toContain(`· asked by <@${CO_IDS.alice}> · ${CO_IDS.checkoutTask}`)
    const board = boardFor(scenario('elsewhere-duplicate'))!
    expect(board).toContain('Elsewhere (read only):')
    expect(board).toContain(`- #${CO_IDS.otherChannelName} · delegated task · running · "Add retry with backoff`)
    expect(board).not.toContain(CO_IDS.webhookTask)
    const [ask] = scopeOf('elsewhere-duplicate').messages
    expect(
      decide(
        { action: 'messageTask', messageId: ask, taskId: CO_IDS.webhookTask },
        scopeOf('elsewhere-duplicate'),
        new Set()
      )
    ).toMatchObject({ error: expect.stringContaining('not one of your open tasks') })
    const again = recorded('elsewhere-duplicate', [{ action: 'delegateTask', messageId: ask, title: 'Webhook retry' }])
    expect(judgeCoordinator(scenario('elsewhere-duplicate'), again, '').verdict).toBe('FAIL')
    const pointed = recorded('elsewhere-duplicate', [
      { action: 'replyToMessage', messageId: ask, message: 'Already in progress in #notify-service: PR #412 is open.' }
    ])
    expect(judgeCoordinator(scenario('elsewhere-duplicate'), pointed, '').verdict).toBe('PASS')
    const vague = recorded('elsewhere-duplicate', [
      { action: 'replyToMessage', messageId: ask, message: 'On it soon.' }
    ])
    expect(judgeCoordinator(scenario('elsewhere-duplicate'), vague, '').verdict).toBe('DEGRADED')
    const answered = judgeCoordinator(scenario('webchat-elsewhere-status'), [], 'Not yet: PR #412 is open, CI running.')
    expect(answered.verdict).toBe('PASS')
    const fixture = await coordinatorFixture()
    try {
      const { url } = fixture.descriptor('e', scopeOf('webchat-elsewhere-status')) as { url: string }
      const listed = await fetch(url, {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'listTasks' } })
      }).then((res) => res.json() as Promise<any>)
      const body = JSON.parse(listed.result.content[0].text)
      expect(body.here).toEqual([])
      expect(body.elsewhere[0]).toMatchObject({ id: CO_IDS.webhookTask, summary: expect.stringContaining('PR #412') })
    } finally {
      fixture.server.close()
    }
  })

  it('answers readTask for a task it knows, refuses any other, and passes only a reply naming its pull request', async () => {
    const board = boardFor(scenario('elsewhere-read-task'))!
    expect(board).toContain(
      `- #${CO_IDS.exportChannelName} · delegated task · running · "Fix the nightly analytics export"`
    )
    // Its summary predates the pull request, which only readTask names.
    expect(JSON.stringify(scenario('elsewhere-read-task').elsewhere)).not.toContain('#57')
    const [ask] = scopeOf('elsewhere-read-task').messages
    const answered = recorded('elsewhere-read-task', [
      { action: 'replyToMessage', messageId: ask, message: 'Yes: https://github.com/example-org/analytics/pull/57' }
    ])
    expect(judgeCoordinator(scenario('elsewhere-read-task'), answered, '').verdict).toBe('PASS')
    const vague = recorded('elsewhere-read-task', [
      { action: 'replyToMessage', messageId: ask, message: 'Not yet, it is still in progress.' }
    ])
    expect(judgeCoordinator(scenario('elsewhere-read-task'), vague, '').verdict).toBe('DEGRADED')
    const fixture = await coordinatorFixture()
    try {
      const { url } = fixture.descriptor('r', scopeOf('elsewhere-read-task')) as { url: string }
      const call = async (taskId: string) =>
        await fetch(url, {
          method: 'POST',
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'readTask', arguments: { taskId } }
          })
        }).then((res) => res.json() as Promise<any>)
      const read = JSON.parse((await call(CO_IDS.exportTask)).result.content[0].text)
      expect(read.opened[0]).toMatchObject({ label: 'example-org/analytics#57' })
      expect((await call(CO_IDS.webhookTask)).result.isError).toBe(true)
      expect(fixture.calls('r').map((one) => [one.tool, one.error === undefined])).toEqual([
        ['readTask', true],
        ['readTask', false]
      ])
    } finally {
      fixture.server.close()
    }
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
