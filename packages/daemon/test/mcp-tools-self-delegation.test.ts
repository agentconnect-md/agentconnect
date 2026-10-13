// The sendMessage and listAgents descriptors teach self-delegation to every agent (assistant-mode.md §5.6).
import { describe, it, expect } from 'vitest'
import { COLLABORATION_TOOLS, toolsForIntegrations } from '../src/mcp/tools.js'
import type { Integration } from '../src/agents/agent-schema.js'

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

type Branch = { required?: string[]; properties: Record<string, { description?: string }> }

const sendTool = (ints: Integration[]) => toolsForIntegrations(ints).find((t) => t.name === 'sendMessage')!
const agentBranch = (ints: Integration[]) =>
  (sendTool(ints).inputSchema as unknown as { oneOf: Branch[] }).oneOf.find((b) => b.required?.includes('toAgent'))!
/** Every description the agent reads about `sendMessage`, joined. */
const allText = (ints: Integration[]) => {
  return [sendTool(ints).description, agentBranch(ints).properties.toAgent!.description].join('\n')
}

const listTool = (ints: Integration[], name: string) => toolsForIntegrations(ints).find((t) => t.name === name)!

describe('listAgents self-delegation wording', () => {
  it.each(['listAgents', 'listChannelAgents'])('%s tells every agent its own id opens a sub-session', (name) => {
    const tool = listTool([slackInt], name)
    expect(tool).toEqual(COLLABORATION_TOOLS.find((t) => t.name === name))
    expect(listTool([], name)).toEqual(tool)
    expect(tool.description).toMatch(
      /conversation with yourself; without `channel`, your own id opens a background sub-session for long work instead \(see `sendMessage`\)\.$/
    )
    expect(tool.description).not.toContain('a postless self-call is rejected')
  })
})

describe('sendMessage self-delegation wording', () => {
  it.each([[[slackInt]], [[]]])('explains the background sub-session to every agent (%#)', (ints) => {
    const text = allText(ints)
    expect(text).toContain('opens a background SUB-SESSION for long work ("fix this bug and open a PR")')
    expect(text).toContain('reports back into this conversation when it finishes or fails')
    expect(text).toContain('Keep ordinary conversation here')
    expect(text).toContain('A sub-session cannot open sub-sessions of its own.')
    expect(text).toContain('Without `channel`, your own ID opens a background sub-session instead')
    expect(text).toContain('This form MAY target yourself: your own # Agent ID opens a new conversation there.')
    expect(text).not.toContain('this form cannot target yourself')
    expect(text).not.toContain('direct form may not target yourself')
    expect(text).not.toContain('a self target without `channel` is rejected')
    expect(text).not.toContain('A self wake is valid only in')
  })
})
