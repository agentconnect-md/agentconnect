// The sendMessage descriptor teaches self-delegation to assistant-mode agents only (assistant-mode.md §5.6).
import { describe, it, expect } from 'vitest'
import { toolsForIntegrations } from '../src/mcp/tools.js'
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

type Branch = { required?: string[]; description?: string; properties: Record<string, { description?: string }> }

const sendTool = (ints: Integration[], options: { assistantMode?: boolean } = {}) =>
  toolsForIntegrations(ints, options).find((t) => t.name === 'sendMessage')!
const agentBranch = (ints: Integration[], options: { assistantMode?: boolean } = {}) =>
  (sendTool(ints, options).inputSchema as unknown as { oneOf: Branch[] }).oneOf.find((b) =>
    b.required?.includes('toAgent')
  )!
/** Every description the agent reads about `sendMessage`, joined. */
const allText = (ints: Integration[], options: { assistantMode?: boolean } = {}) => {
  const branch = agentBranch(ints, options)
  return [sendTool(ints, options).description, branch.description, branch.properties.toAgent!.description].join('\n')
}

describe('sendMessage self-delegation wording', () => {
  it.each([[[slackInt]], [[]]])('is the same descriptor for every other agent (%#)', (ints) => {
    expect(sendTool(ints, { assistantMode: false })).toEqual(sendTool(ints))
    const text = allText(ints)
    expect(text).not.toMatch(/sub-session/i)
    expect(text).toContain('this form cannot target yourself')
    expect(text).toContain('direct form may not target yourself')
    expect(text).toContain('a self target without `channel` is rejected')
    expect(text).toContain('A self wake is valid only in the explicit `toAgent` channel-root form above.')
  })

  it('explains the background sub-session to an assistant-mode agent only', () => {
    const text = allText([slackInt], { assistantMode: true })
    expect(text).toContain('opens a background SUB-SESSION for long work ("fix this bug and open a PR")')
    expect(text).toContain('reports back into this conversation when it finishes or fails')
    expect(text).toContain('Keep ordinary conversation here')
    expect(text).toContain('A sub-session cannot open sub-sessions of its own.')
    expect(text).toContain('your own ID without `channel` opens a background sub-session instead')
    expect(text).not.toContain('this form cannot target yourself')
    expect(text).not.toContain('direct form may not target yourself')
    expect(text).not.toContain('a self target without `channel` is rejected')
    // The wording changes; the shape the agent calls does not.
    const strip = (value: unknown): unknown =>
      JSON.parse(JSON.stringify(value, (key, v) => (key === 'description' ? undefined : v)))
    expect(strip(sendTool([slackInt], { assistantMode: true }).inputSchema)).toEqual(
      strip(sendTool([slackInt]).inputSchema)
    )
  })
})
