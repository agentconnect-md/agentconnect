// The sendMessage, getToolGuide and listAgents surfaces teach delegated tasks to every agent (send-message-guide.md §2.1).
import { describe, it, expect } from 'vitest'
import { COLLABORATION_TOOLS, collaborationTools, toolsForIntegrations } from '../src/mcp/tools.js'
import { SEND_MESSAGE_ACTIONS } from '../src/mcp/ops/send-message-actions.js'
import type { TaskReach } from '../src/session/subsession-coordinate.js'
import type { Integration } from '../src/agents/agent-schema.js'
import { sendMessageGuide } from '../src/mcp/ops/tool-guide.js'
import type { SessionContext } from '../src/mcp/ops/context.js'

const slackInt: Integration = {
  id: 'int-1',
  platform: 'slack',
  core: {
    mode: 'direct',
    bindRules: [],
    mutedChannels: [],
    gated: false,
    sessionModes: [],
    decisions: { bindings: [], definitions: [] }
  },
  config: { botToken: 'xoxb', appToken: 'xapp' }
}

const sendTool = (ints: Integration[]) => toolsForIntegrations(ints).find((t) => t.name === 'sendMessage')!
const ctx = (ints: Integration[]): SessionContext => ({
  agentId: 'bot-a',
  platform: 'slack',
  isDm: false,
  channel: 'C1',
  thread: '100.1',
  deliveryThread: '100.1',
  tools: toolsForIntegrations(ints),
  integrations: ints.map((i) => ({ id: i.id, platform: i.platform }))
})
/** Every description and guide rule the agent reads about self-delegation, joined. */
const allText = (ints: Integration[]) =>
  [
    sendTool(ints).description,
    ...(sendMessageGuide(ctx(ints), 'delegateTask').rules as string[]),
    ...(sendMessageGuide(ctx(ints), 'callAgent').rules as string[])
  ].join('\n')

const listTool = (ints: Integration[], name: string) => toolsForIntegrations(ints).find((t) => t.name === name)!

describe('listAgents self-delegation wording', () => {
  it.each(['listAgents', 'listChannelAgents'])('%s steers every agent’s own long work to delegateTask', (name) => {
    const tool = listTool([slackInt], name)
    expect(tool).toEqual(COLLABORATION_TOOLS.find((t) => t.name === name))
    expect(listTool([], name)).toEqual(tool)
    expect(tool.description).toMatch(
      /conversation with yourself; to hand long work of your own to a task, use `delegateTask` instead \(see `getToolGuide`\)\.$/
    )
    expect(tool.description).not.toContain('a postless self-call is rejected')
  })
})

describe('sendMessage self-delegation wording', () => {
  it.each([[[slackInt]], [[]]])('explains the delegated task to every agent (%#)', (ints) => {
    const text = allText(ints)
    expect(text).toContain('delegateTask hands long work of your own, spanning turns, to a task of this session')
    expect(text).toContain('long work that spans turns, may run a long time, or that people should be able to see')
    expect(text).toContain('("fix this bug and open a PR")')
    expect(text).toContain(
      'reports back into this session automatically each time a round of its work finishes or fails'
    )
    expect(text).toContain('Questions, lookups and short answers never need a task')
    expect(text).toContain(
      'A task may delegate tasks of its own, which report back to it; a task that another task started cannot'
    )
    expect(text).toContain('`title` is a short name for the work')
    expect(text).toContain('your own id without `channel` is refused — work of your own that needs no conversation')
    expect(text).not.toMatch(/sub-session|messageSubsession/)
    expect(text).toContain('Your own id (bot-a) with `channel` opens and activates a visible conversation of your own')
    expect(text).not.toContain('this form cannot target yourself')
    expect(text).not.toContain('A self wake is valid only in')
  })

  it.each([[[slackInt]], [[]]])('splits work between the runtime’s own subagents and delegateTask (%#)', (ints) => {
    const description = sendTool(ints).description
    // Within this turn → the runtime's own subagent tool; spanning turns, seen and stoppable → delegateTask.
    expect(description).toContain('Work you finish within this turn goes to your runtime’s own subagent tool.')
    expect(description).toContain('to a task of this session that people can see and stop')
    const guide = sendMessageGuide(ctx(ints), 'delegateTask')
    expect((guide.rules as string[])[0]).toBe(
      'Work you can finish within this turn, even split into parallel parts, goes to your runtime’s own subagent ' +
        'or Task tool instead. Use delegateTask for long work that spans turns, may run a long time, or that people ' +
        'should be able to see and stop ("fix this bug and open a PR").'
    )
    expect(guide.purpose).toContain('outlives this turn, which people can see and stop')
  })

  it.each([[[slackInt]], [[]]])('starts tasks for the request, proposes what it noticed on its own (%#)', (ints) => {
    const rules = sendMessageGuide(ctx(ints), 'delegateTask').rules as string[]
    expect(rules[1]).toBe(
      'A task serves the request you are answering: its independent parts, or long work that would hold up this ' +
        'conversation, start without asking. Work you noticed on your own, or that an announcement or a relayed ' +
        'message mentions, is proposed, not started; when in doubt, do not delegate. "check again" asks for a status, ' +
        'not for the work again.'
    )
  })
})

describe('where only the coordinator delegates (auto-session-mode.md §5.1)', () => {
  const surface = (taskReach: TaskReach) => {
    const tools = toolsForIntegrations([slackInt], { taskReach })
    const send = tools.find((tool) => tool.name === 'sendMessage')!
    const schema = send.inputSchema as { properties: Record<string, { enum?: string[] }> }
    return { tools, send, schema, actions: schema.properties.action!.enum! }
  }

  it('gives every other session no delegateTask, and messageTask only for assistant mode’s own tasks', () => {
    const full = surface('delegate')
    expect(full.actions).toEqual([...SEND_MESSAGE_ACTIONS])
    expect(full.send).toEqual(sendTool([slackInt]))

    const assistant = surface('assistant')
    expect(assistant.actions).toEqual(['callAgent', 'messageTask', 'replyToSession', 'postMessage'])
    expect(Object.keys(assistant.schema.properties)).toContain('taskId')
    expect(Object.keys(assistant.schema.properties)).not.toContain('title')
    expect(assistant.send.description).toContain(
      'messageTask gives a follow-up of this conversation new instructions, or your organization research another round'
    )

    const none = surface('none')
    expect(none.actions).toEqual(['callAgent', 'replyToSession', 'postMessage'])
    expect(Object.keys(none.schema.properties)).not.toContain('taskId')
    for (const { send } of [assistant, none]) {
      expect(send.description).not.toContain('delegateTask')
      expect(send.description).toContain('replyToSession answers a message another session sent you')
    }
    expect(none.send.description).not.toMatch(/messageTask|listTasks|stopTask/)
  })

  it.each(['listAgents', 'listChannelAgents'])('%s points no other session at delegateTask', (name) => {
    const tool = surface('none').tools.find((t) => t.name === name)!
    expect(tool).toEqual(collaborationTools(false).find((t) => t.name === name))
    expect(tool.description).toMatch(/a new channel-root conversation with yourself\.$/)
    expect(tool.description).not.toContain('delegateTask')
  })

  it('says in getToolGuide that only the coordinator delegates, and what messageTask still reaches', () => {
    const at = ctx([slackInt])
    const assistant = sendMessageGuide(at, undefined, 'assistant').actions as {
      action: string
      availability?: string
    }[]
    const note = (list: typeof assistant, action: string) => list.find((entry) => entry.action === action)?.availability
    expect(note(assistant, 'delegateTask')).toMatch(/^Unavailable here: only an Auto conversation’s coordinator/)
    expect(note(assistant, 'messageTask')).toMatch(/^Here it reaches only a follow-up of this conversation/)
    const none = sendMessageGuide(at, undefined, 'none').actions as typeof assistant
    expect(note(none, 'messageTask')).toBe('Unavailable here: this session has no task it can message.')
    const callAgent = sendMessageGuide(at, 'callAgent', 'none').rules as string[]
    expect(callAgent.join('\n')).not.toContain('delegateTask')
    expect(callAgent.join('\n')).toContain('work of your own that needs no conversation is done in this session.')
  })
})
