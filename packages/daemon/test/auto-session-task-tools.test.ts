// auto-session-mode.md §5.1, §6.3: once only the coordinator delegates, every other session opens no task and keeps assistant mode's own.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { TASKS_COORDINATOR_ONLY } from '../src/collab/coordinator.js'
import { executeTool, type SessionContext } from '../src/mcp/ops.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { researchCoordinate, subsessionCoordinate } from '../src/session/subsession-coordinate.js'
import { sessionKey } from '../src/store/local-store.js'
import type { ToolDescriptor } from '../src/tool-schema/descriptor.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const AGENT = 'bot-a'
const INT = 'int-bot-a'

function scaffold(opts: { assistantMode: boolean; autoSessionMode?: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-task-tools-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      features: { autoSessionMode: opts.autoSessionMode !== false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  const adir = join(root, 'agents', AGENT)
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: AGENT,
      name: AGENT,
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [
        {
          id: INT,
          platform: 'slack',
          core: {
            bindRules: [{ match: { kind: 'mention' } }],
            sessionModes: [
              { channel: 'C1', mode: 'createNew' },
              { channel: 'C2', mode: 'append' }
            ]
          },
          config: { botToken: 'xoxb', appToken: 'xapp' }
        }
      ],
      output: { mode: 'low' },
      ...(opts.assistantMode ? { assistantMode: { enabled: true } } : {})
    })
  )
  return root
}

async function boot(opts: { assistantMode: boolean; autoSessionMode?: boolean }) {
  const daemon = new Daemon({ root: scaffold(opts), slackAppFactory: fakeSlackAppFactory() })
  await daemon.start()
  const d = daemon as any
  const scope: string = d.transportScopeForIntegrationIds([INT])
  const agent = d.agents.get(AGENT)
  const offered = (channel: string, thread: string, threadedTask?: boolean): ToolDescriptor[] =>
    d.sessionBridgeTools(agent, {
      platform: 'slack',
      channel,
      thread,
      integrationId: INT,
      isDm: false,
      ...(threadedTask ? { threadedTask } : {})
    })
  const ctx = (channel: string, thread: string): SessionContext => ({
    agentId: AGENT,
    platform: 'slack',
    integrationId: INT,
    transportScope: scope,
    isDm: false,
    channel,
    thread,
    deliveryThread: thread,
    tools: offered(channel, thread)
  })
  return { daemon, d, scope, offered, ctx }
}

const TASK_TOOLS = ['listTasks', 'stopTask', 'updateTask']
const names = (tools: ToolDescriptor[]) => tools.map((tool) => tool.name)
const actions = (tools: ToolDescriptor[]) =>
  (
    tools.find((tool) => tool.name === 'sendMessage')!.inputSchema as unknown as {
      properties: { action: { enum: string[] } }
    }
  ).properties.action.enum
const description = (tools: ToolDescriptor[], name: string) => tools.find((tool) => tool.name === name)?.description

describe('the task tools each session is offered once only the coordinator delegates (§5.1)', () => {
  it('gives a Per thread session, a Single session and a task no task tool, and a task its summary', async () => {
    const { daemon, offered } = await boot({ assistantMode: false })
    for (const session of [offered('C1', '1.1'), offered('C2', 'append:1')]) {
      expect(actions(session)).toEqual(['callAgent', 'replyToSession', 'postMessage'])
      expect(names(session).filter((name) => TASK_TOOLS.includes(name))).toEqual([])
      expect(description(session, 'listAgents')).not.toContain('delegateTask')
    }
    for (const task of [offered('C1', subsessionCoordinate('1')), offered('C1', '2.1', true)]) {
      expect(actions(task)).toEqual(['callAgent', 'replyToSession', 'postMessage'])
      expect(names(task).filter((name) => TASK_TOOLS.includes(name))).toEqual(['updateTask'])
    }
    await daemon.stop()
  })

  it('keeps an assistant-mode place session messageTask, listTasks and stopTask for its follow-ups and research', async () => {
    const { daemon, offered } = await boot({ assistantMode: true })
    const place = offered('C2', 'append:1')
    expect(actions(place)).toEqual(['callAgent', 'messageTask', 'replyToSession', 'postMessage'])
    expect(description(place, 'listTasks')).toMatch(
      /^List the follow-ups of this conversation, your organization research/
    )
    expect(description(place, 'stopTask')).toMatch(
      /^End a follow-up of this conversation, or stop your organization research/
    )
    expect(names(place)).toContain('followUp')
    const task = offered('C1', subsessionCoordinate('1'))
    expect(names(task)).not.toContain('listTasks')
    expect(actions(task)).not.toContain('messageTask')
    await daemon.stop()
  })

  it('offers every task tool, nesting included, while the Auto switch is off', async () => {
    const { daemon, offered } = await boot({ assistantMode: false, autoSessionMode: false })
    for (const session of [offered('C1', '1.1'), offered('C1', subsessionCoordinate('1'))]) {
      expect(actions(session)).toContain('delegateTask')
      expect(names(session)).toEqual(expect.arrayContaining(['listTasks', 'stopTask']))
    }
    await daemon.stop()
  })

  it('reads the same reach when a tool is called, a threaded task included', async () => {
    const { daemon, d, scope, ctx } = await boot({ assistantMode: true })
    await d.store.assistantSubsessions.open({
      agentId: AGENT,
      childSessionKey: sessionKey('slack', 'C1', '2.1', AGENT, scope),
      parentSessionId: 'sid-coordinator',
      parentSessionKey: sessionKey('slack', 'C1', 'append:coordinator-1', AGENT, scope),
      title: 'Flaky test',
      now: 1
    })
    expect(await d.taskReach(ctx('C1', 'append:coordinator-1'))).toBe('delegate')
    expect(await d.taskReach(ctx('C2', 'append:1'))).toBe('assistant')
    expect(await d.taskReach(ctx('C1', '2.1'))).toBe('none')
    expect(await d.taskReach(ctx('C1', subsessionCoordinate('1')))).toBe('none')
    await daemon.stop()
  })
})

describe('what the daemon refuses outside the coordinator (§5.1)', () => {
  it('refuses delegateTask and a self-delegating wake, and opens nothing', async () => {
    const { daemon, d, scope, ctx } = await boot({ assistantMode: false })
    const deps = { ...d.mcp.deps, canRun: () => true }
    const refused = await executeTool(
      ctx('C1', '1.1'),
      'sendMessage',
      { action: 'delegateTask', title: 'Release notes', message: 'write the release notes' },
      deps
    ).then(
      () => undefined,
      (err: Error) => err.message
    )
    expect(refused).toContain('action `delegateTask` is not available in this session')
    const wake = await d.collab.messageAgent({
      callerAgentId: AGENT,
      platform: 'slack',
      callerChannel: 'C1',
      callerThread: '1.1',
      callerTransportScope: scope,
      toAgentId: AGENT,
      text: 'write the release notes',
      channel: 'C1',
      thread: '1.1',
      postless: true
    })
    expect(wake).toMatchObject({ delivered: false, reason: TASKS_COORDINATOR_ONLY })
    expect(
      await d.store.assistantSubsessions.hasRunningChildren(AGENT, sessionKey('slack', 'C1', '1.1', AGENT, scope))
    ).toBe(false)
    await daemon.stop()
  })

  it('gives a delegated task no more work from its owner, but still takes the owner’s message to its research', async () => {
    const { daemon, d, scope } = await boot({ assistantMode: true })
    const caller = sessionKey('slack', 'C2', 'append:1', AGENT, scope)
    await d.store.upsertSession({
      key: caller,
      agentId: AGENT,
      platform: 'slack',
      channel: 'C2',
      thread: 'append:1',
      transportScope: scope,
      acpSessionId: 'acp-owner',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    const owner = await d.store.ensureOutwardSessionId(caller, AGENT, Date.now())
    const open = async (thread: string) => {
      const key = sessionKey('slack', 'C2', thread, AGENT, scope)
      await d.store.assistantSubsessions.open({
        agentId: AGENT,
        childSessionKey: key,
        parentSessionId: owner,
        parentSessionKey: caller,
        now: Date.now()
      })
      await d.store.assistantSubsessions.finish(AGENT, key, 'done')
      return key
    }
    const delegated = await open(subsessionCoordinate('1'))
    const research = await open(researchCoordinate('1'))
    const dispatched: NormalizedMessage[] = []
    d.dispatch = vi.fn(
      async (_agentId: string, msg: NormalizedMessage, _i?: string, _w?: unknown, _c?: unknown, o?: any) => {
        dispatched.push(msg)
        o?.onAdmission?.({ accepted: true })
        return 'acp-1'
      }
    )
    const message = (sessionId: string) =>
      d.collab.continueSubsession({
        callerAgentId: AGENT,
        platform: 'slack',
        callerChannel: 'C2',
        callerThread: 'append:1',
        callerTransportScope: scope,
        sessionId,
        text: 'once more',
        assistantTasksOnly: true
      })
    expect(await message(delegated)).toMatchObject({ delivered: false, reason: TASKS_COORDINATOR_ONLY })
    expect(dispatched).toHaveLength(0)
    expect(await message(research)).toMatchObject({ delivered: true, targetSession: research })
    expect(dispatched).toHaveLength(1)
    await daemon.stop()
  })
})
