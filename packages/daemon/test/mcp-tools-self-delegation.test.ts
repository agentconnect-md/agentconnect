// The sendMessage, getToolGuide and listAgents surfaces teach delegated tasks to every agent (send-message-guide.md §2.1).
import { describe, it, expect } from 'vitest'
import { COLLABORATION_TOOLS, toolsForIntegrations } from '../src/mcp/tools.js'
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
    expect(text).toContain('delegateTask hands work that spans turns or runs long')
    expect(text).toContain('long work that spans turns, may run a long time, or that people should be able to see')
    expect(text).toContain('("fix this bug and open a PR")')
    expect(text).toContain(
      'reports back into this session automatically each time a round of its work finishes or fails'
    )
    expect(text).toContain('Questions, lookups and short answers never need a task')
    expect(text).toContain('A task cannot start tasks of its own')
    expect(text).toContain('your own id without `channel` is refused — work of your own that needs no conversation')
    expect(text).not.toMatch(/sub-session|messageSubsession/)
    expect(text).toContain('Your own id (bot-a) with `channel` opens and activates a visible conversation of your own')
    expect(text).not.toContain('this form cannot target yourself')
    expect(text).not.toContain('A self wake is valid only in')
  })

  it.each([[[slackInt]], [[]]])('splits work between the runtime’s own subagents and delegateTask (%#)', (ints) => {
    const description = sendTool(ints).description
    // Within this turn → the runtime's own subagent tool; spanning turns, seen and stoppable → delegateTask.
    expect(description).toContain('Short work stays here or with your runtime’s subagents.')
    expect(description).toContain('which people should see and stop, to a task of this session')
    const guide = sendMessageGuide(ctx(ints), 'delegateTask')
    expect((guide.rules as string[])[0]).toBe(
      'Work you can finish within this turn, even split into parallel parts, goes to your runtime’s own subagent ' +
        'or Task tool instead. Use delegateTask for long work that spans turns, may run a long time, or that people ' +
        'should be able to see and stop ("fix this bug and open a PR"). Quick lookups stay in this turn.'
    )
    expect(guide.purpose).toContain('outlives this turn, which people can see and stop')
  })

  it.each([[[slackInt]], [[]]])('asks for confirmation before delegating live-environment work (%#)', (ints) => {
    expect(sendTool(ints).description).toContain(
      'Ask the person before delegating live-environment changes; "check again" is a lookup, not approval.'
    )
    const rules = sendMessageGuide(ctx(ints), 'delegateTask').rules as string[]
    expect(rules[1]).toBe(
      'Confirm with the person before delegating work that changes a live environment (deploys, upgrades, ' +
        'infrastructure, data); a follow-up such as "check again" asks for a status lookup, not to run it again.'
    )
  })
})
