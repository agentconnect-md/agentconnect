// The sendMessage, getToolGuide and listAgents surfaces teach background tasks to every agent (send-message-guide.md §2.1).
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
    ...(sendMessageGuide(ctx(ints), 'startTask').rules as string[]),
    ...(sendMessageGuide(ctx(ints), 'callAgent').rules as string[])
  ].join('\n')

const listTool = (ints: Integration[], name: string) => toolsForIntegrations(ints).find((t) => t.name === name)!

describe('listAgents self-delegation wording', () => {
  it.each(['listAgents', 'listChannelAgents'])('%s steers every agent’s own background work to startTask', (name) => {
    const tool = listTool([slackInt], name)
    expect(tool).toEqual(COLLABORATION_TOOLS.find((t) => t.name === name))
    expect(listTool([], name)).toEqual(tool)
    expect(tool.description).toMatch(
      /conversation with yourself; for background work of your own, use `startTask` instead \(see `getToolGuide`\)\.$/
    )
    expect(tool.description).not.toContain('a postless self-call is rejected')
  })
})

describe('sendMessage self-delegation wording', () => {
  it.each([[[slackInt]], [[]]])('explains the background task to every agent (%#)', (ints) => {
    const text = allText(ints)
    expect(text).toContain('startTask starts a background task of this session for long work you do yourself')
    expect(text).toContain('Use it for long work of your own ("fix this bug and open a PR")')
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
})
