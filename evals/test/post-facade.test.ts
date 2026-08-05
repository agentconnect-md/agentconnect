import { describe, expect, it } from 'vitest'
import { toolsForIntegrations } from '../../packages/daemon/src/mcp/tools.js'
import { IntegrationSchema } from '../../packages/daemon/src/agents/agent-schema.js'
import { POST_TOOL_DESCRIPTOR, PostCompileError, compilePost, postFacadeTool } from '../games/post-facade.js'

/**
 * Arm B's contract, credential-free: the façade must compile every legal
 * `sendMessage` form and refuse the rest, and the STATIC cost of each surface
 * must be measurable without a model. Both are prerequisites for the A/B being
 * a fair comparison rather than two different implementations.
 */

const AGENT = '4722901a-eec4-466d-8128-174123af6af0'
const OTHER_AGENT = '1a6646ba-b35b-44fe-9ea5-0c8baeba7f7a'

describe('post façade — compiles to exactly one legal sendMessage form', () => {
  it('covers all six legal forms of the landed surface', () => {
    // Case 1: wake one agent AND post a visible root in a channel.
    expect(compilePost({ conversation: { kind: 'channel', channel: 'C1' }, address: [AGENT], message: 'hi' })).toEqual({
      form: 'agent-channel',
      args: { toAgent: AGENT, channel: 'C1', message: 'hi' }
    })
    // Case 2: bare visible root, nobody woken, nobody mentioned.
    expect(compilePost({ conversation: { kind: 'channel', channel: 'C1' }, message: 'hi' })).toEqual({
      form: 'channel-bare',
      args: { channel: 'C1', message: 'hi' }
    })
    // Postless peer wake: a private conversation has no platform projection.
    expect(
      compilePost({ conversation: { kind: 'private' }, address: [AGENT], visibility: 'session-only', message: 'hi' })
    ).toEqual({ form: 'agent-postless', args: { toAgent: AGENT, message: 'hi' } })
    // DM to a human.
    expect(compilePost({ conversation: { kind: 'dm', user: 'U1' }, message: 'hi' })).toEqual({
      form: 'user-dm',
      args: { toUser: 'U1', message: 'hi' }
    })
    // Channel root addressing humans — one id and many.
    expect(compilePost({ conversation: { kind: 'channel', channel: 'C1' }, address: ['U1'], message: 'hi' })).toEqual({
      form: 'user-channel',
      args: { toUser: 'U1', channel: 'C1', message: 'hi' }
    })
    expect(
      compilePost({ conversation: { kind: 'channel', channel: 'C1' }, address: ['U1', 'U2'], message: 'hi' })
    ).toEqual({ form: 'user-channel', args: { toUser: ['U1', 'U2'], channel: 'C1', message: 'hi' } })
    // Session-only reply into the parent conversation.
    expect(compilePost({ conversation: { kind: 'parent', sessionId: 'S1' }, message: 'hi' })).toEqual({
      form: 'parent-session',
      args: { sessionId: 'S1', message: 'hi' }
    })
  })

  it('carries needsReply through as an orthogonal flag', () => {
    expect(
      compilePost({
        conversation: { kind: 'private' },
        address: [AGENT],
        visibility: 'session-only',
        expectReply: true,
        message: 'q'
      }).args
    ).toEqual({ toAgent: { agentId: AGENT, needsReply: true }, message: 'q' })
  })

  it('refuses an under-specified post instead of guessing a target', () => {
    // Guessing is the exact failure a surface comparison must not hide.
    expect(() => compilePost({ message: 'hi' })).toThrow(PostCompileError)
    expect(() => compilePost({ conversation: { kind: 'channel' }, message: 'hi' })).toThrow(/conversation\.channel/)
    expect(() => compilePost({ conversation: { kind: 'dm' }, message: 'hi' })).toThrow(/conversation\.user/)
    expect(() => compilePost({ conversation: { kind: 'parent' }, message: 'hi' })).toThrow(/conversation\.sessionId/)
    expect(() => compilePost({ conversation: { kind: 'nope' }, message: 'hi' })).toThrow(/unknown conversation\.kind/)
    expect(() => compilePost({ conversation: { kind: 'channel', channel: 'C1' } })).toThrow(/"message"/)
  })

  it('refuses combinations the product has no form for, rather than inventing one', () => {
    // A channel post is always visible; session-only lives on `private`.
    expect(() =>
      compilePost({ conversation: { kind: 'channel', channel: 'C1' }, visibility: 'session-only', message: 'hi' })
    ).toThrow(/always visible/)
    // A private conversation is exactly one agent, and has no visible form.
    expect(() => compilePost({ conversation: { kind: 'private' }, message: 'hi' })).toThrow(/exactly one agent/)
    expect(() =>
      compilePost({ conversation: { kind: 'private' }, address: [AGENT], visibility: 'visible', message: 'hi' })
    ).toThrow(/session-only/)
    // The product's channel form wakes at most one agent.
    expect(() =>
      compilePost({ conversation: { kind: 'channel', channel: 'C1' }, address: [AGENT, OTHER_AGENT], message: 'hi' })
    ).toThrow(/at most one agent/)
  })

  it('executes through the PRODUCT tool, never its own implementation', async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = []
    const records: { outcome: string; form?: string }[] = []
    const tool = postFacadeTool({ onCall: (record) => records.push({ outcome: record.outcome, form: record.form }) })
    await tool.handler({
      runId: 'r',
      agentId: AGENT,
      sessionContext: {} as never,
      input: { conversation: { kind: 'channel', channel: 'C1' }, message: 'hi' },
      callProductTool: async (name, args) => {
        calls.push({ name, args })
        return { ok: true }
      }
    })
    // The façade adds a schema, not a second implementation.
    expect(calls).toEqual([{ name: 'sendMessage', args: { channel: 'C1', message: 'hi' } }])
    expect(records).toEqual([{ outcome: 'compiled', form: 'channel-bare' }])
  })

  it('reports an invalid call without reaching the product tool', async () => {
    const calls: string[] = []
    const records: { outcome: string; error?: string }[] = []
    const tool = postFacadeTool({ onCall: (record) => records.push({ outcome: record.outcome, error: record.error }) })
    await expect(
      tool.handler({
        runId: 'r',
        agentId: AGENT,
        sessionContext: {} as never,
        input: { message: 'hi' },
        callProductTool: async (name) => {
          calls.push(name)
          return {}
        }
      })
    ).rejects.toThrow(PostCompileError)
    expect(calls).toEqual([])
    expect(records[0]!.outcome).toBe('invalid')
  })
})

describe('static cost of each tool surface', () => {
  /** Characters of schema + description the model must carry for one tool. */
  function staticCost(descriptor: { name: string; description?: string; inputSchema?: unknown }) {
    const description = descriptor.description ?? ''
    const schema = JSON.stringify(descriptor.inputSchema ?? {})
    return {
      descriptionChars: description.length,
      schemaChars: schema.length,
      totalChars: description.length + schema.length,
      // A rough, tokenizer-free estimate. Reported as approximate on purpose.
      approxTokens: Math.round((description.length + schema.length) / 4)
    }
  }

  function sendMessageDescriptor() {
    const integration = IntegrationSchema.parse({
      id: 'i1',
      platform: 'slack',
      core: { mode: 'direct', bindRules: [] },
      config: { botToken: 'xoxb-x', appToken: 'xapp-x' }
    })
    const tool = toolsForIntegrations([integration], { collaboration: true }).find((t) => t.name === 'sendMessage')
    if (!tool) throw new Error('sendMessage descriptor not found')
    return tool
  }

  it('measures both surfaces from the real descriptors, not from prose', () => {
    const a = staticCost(sendMessageDescriptor())
    const b = staticCost(POST_TOOL_DESCRIPTOR)
    // Pin the shape of the measurement, not the exact numbers: the assertion is
    // that both are measurable and that the façade is not accidentally larger.
    expect(a.totalChars).toBeGreaterThan(1000)
    expect(b.totalChars).toBeGreaterThan(500)
    expect(b.totalChars).toBeLessThan(a.totalChars)
    // Report them so a run of this test records the numbers.
    console.log(`static cost — sendMessage: ${JSON.stringify(a)}  post: ${JSON.stringify(b)}`)
  })

  it('the landed surface really does enumerate more forms than the façade', () => {
    const description = sendMessageDescriptor().description ?? ''
    // Arm A's description spells out target modes and their illegal pairings;
    // arm B's spells out three independent dimensions. Counting the literal
    // JSON form templates is the closest objective proxy.
    const armAForms = (description.match(/`\{"/g) ?? []).length
    const armBForms = (POST_TOOL_DESCRIPTOR.description.match(/`\{"/g) ?? []).length
    expect(armAForms).toBeGreaterThanOrEqual(6)
    expect(armBForms).toBeLessThan(armAForms)
  })
})
