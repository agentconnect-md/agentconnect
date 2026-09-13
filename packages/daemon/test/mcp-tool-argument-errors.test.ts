import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { executeTool, type OpsDeps, type SessionContext } from '../src/mcp/ops.js'
import { parseArgs, requiredString, ToolArgumentError } from '../src/mcp/ops/args.js'
import { describeToolArgumentFailure, unknownArgumentKeys } from '../src/mcp/ops/argument-error.js'
import { MEMORY_TOOLS } from '../src/memory/tools.js'
import { obj, unionOf } from '../src/tool-schema/descriptor.js'
import type { MemoryProvider } from '../src/memory/provider.js'

// #1921: the rejection is all the model reads before retrying, so it must carry tool, issues, shape, and keys.
const ctx: SessionContext = {
  agentId: 'bot-a',
  platform: 'slack',
  isDm: false,
  channel: 'C1',
  thread: '1.1',
  tools: MEMORY_TOOLS
}

function deps(over: Partial<OpsDeps> = {}): OpsDeps {
  return {
    gatewayFor: () => undefined,
    channelAgents: async () => ({ platform: 'slack', agents: [] }),
    messageAgent: async () => ({ delivered: true, targetSession: 'stub' }),
    replyToSession: async () => ({ delivered: true, targetSession: 'stub' }),
    startOrchestration: async () => ({ orchestrationId: 'o', delivered: [], failed: [] }),
    getOrchestration: async () => null,
    cancelOrchestration: async () => false,
    memory: {
      read: vi.fn(async (_scope: unknown, path: string) => ({ path, content: '# index\n' })),
      write: vi.fn(async () => ({ ok: true }))
    } as unknown as MemoryProvider,
    recordOutbound: async () => {},
    now: () => 1000,
    ...over
  }
}

describe('parseArgs', () => {
  it('reports every issue at once, not just the first', () => {
    const schema = z.object({ a: requiredString('a'), b: requiredString('b') })
    let caught: unknown
    try {
      parseArgs(schema, { c: 1 })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ToolArgumentError)
    const error = caught as ToolArgumentError
    expect(error.issues).toEqual(['missing required string argument: a', 'missing required string argument: b'])
    // The joined message keeps every existing `toThrow('argument …')` substring assertion valid.
    expect(error.message).toBe('missing required string argument: a; missing required string argument: b')
  })
})

describe('executeTool argument errors', () => {
  it('names the tool, the accepted shape, and the sibling that owns the received keys', async () => {
    const d = deps()
    const call = executeTool(ctx, 'readMemory', { oldString: 'x', newString: 'y' }, d)
    await expect(call).rejects.toThrow(/^readMemory: invalid arguments — unexpected arguments: oldString, newString\./)
    await expect(call).rejects.toThrow(/Accepted arguments: \{ path\?: string — Memory file name/)
    await expect(call).rejects.toThrow(
      /Received keys: oldString, newString\. Not accepted by readMemory: oldString, newString — those are writeMemory arguments\./
    )
    // The conflated call never reached the store — it did not quietly read the index instead.
    expect((d.memory as unknown as { read: ReturnType<typeof vi.fn> }).read).not.toHaveBeenCalled()
  })

  it('keeps tolerating stray keys on tools that never promised to reject them', async () => {
    // Only the two memory file tools went strict (#1921); `listAgents` still ignores untrusted
    // identity fields in favour of the session context, as its own tests pin down.
    const channelAgents = vi.fn(async () => ({ platform: 'slack', agents: [] }))
    await expect(
      executeTool(ctx, 'listAgents', { requesterAgentId: 'someone-else' }, deps({ channelAgents }))
    ).resolves.toBeDefined()
    expect(channelAgents).toHaveBeenCalledOnce()
  })

  it('rewrites a handler-level argument error with the same context', async () => {
    const call = executeTool(ctx, 'writeMemory', { path: 'deploys.md' }, deps())
    await expect(call).rejects.toThrow(/^writeMemory: invalid arguments — missing required string argument: content\./)
    await expect(call).rejects.toThrow(
      /Accepted arguments: \{ path\?: string — .*; content\?: string — .*; oldString\?: string — .*; newString\?: string — .* \}/
    )
    await expect(call).rejects.toThrow(/Received keys: path\.$/)
  })

  it('records rejected argument KEY NAMES at debug, never values', async () => {
    const debug = vi.fn()
    await expect(
      executeTool(ctx, 'readMemory', { oldString: 'the secret text', newString: 'y' }, deps({ log: { debug } }))
    ).rejects.toThrow(/readMemory/)
    expect(debug).toHaveBeenCalledOnce()
    const line = debug.mock.calls[0]![0] as string
    expect(line).toContain('tool readMemory: rejected arguments (keys: oldString, newString)')
    expect(line).not.toContain('the secret text')
  })

  it("reports the call's own keys when a handler rejected a nested object", async () => {
    // sendMessage parses `toAgent` as its own object; its field names are not sendMessage arguments.
    const withSend: SessionContext = {
      ...ctx,
      tools: [
        ...MEMORY_TOOLS,
        {
          name: 'sendMessage',
          description: '',
          inputSchema: obj({ toAgent: { type: 'object' }, message: { type: 'string' } }, ['toAgent', 'message'])
        }
      ]
    }
    const call = executeTool(
      withSend,
      'sendMessage',
      { toAgent: { agentId: 'peer', needsReply: 123 }, message: 'hi' },
      deps()
    )
    await expect(call).rejects.toThrow(/^sendMessage: invalid arguments — /)
    await expect(call).rejects.toThrow(/Received keys: toAgent, message\.$/)
    await expect(call).rejects.not.toThrow(/Not accepted by sendMessage/)
  })

  it('still serves a well-formed call', async () => {
    await expect(executeTool(ctx, 'readMemory', { path: 'deploys.md' }, deps())).resolves.toMatchObject({
      path: 'deploys.md'
    })
  })
})

describe('describeToolArgumentFailure', () => {
  it('renders a oneOf union as alternatives and skips the sibling hint when nobody owns the keys', () => {
    const union = {
      name: 'sendMessage',
      description: '',
      inputSchema: unionOf([
        obj({ channel: { type: 'string' }, message: { type: 'string' } }, ['channel', 'message']),
        obj({ toUser: { type: 'string' }, message: { type: 'string' } }, ['toUser', 'message'])
      ])
    }
    expect(unknownArgumentKeys(union.inputSchema, { channel: 'C', bogus: 1 })).toEqual(['bogus'])
    const text = describeToolArgumentFailure({
      tool: 'sendMessage',
      issues: ['unexpected argument: bogus'],
      receivedKeys: ['channel', 'bogus'],
      advertised: union,
      tools: [union]
    })
    expect(text).toContain(
      'Accepted arguments: one of { channel: string; message: string } | { toUser: string; message: string }'
    )
    expect(text).toContain('Not accepted by sendMessage: bogus.')
    expect(text).not.toContain('those are')
  })

  it('falls back to the validator when the session was never advertised the tool', () => {
    const text = describeToolArgumentFailure({
      tool: 'listChannelAgents',
      issues: ['argument channel must be a string'],
      receivedKeys: ['channel'],
      tools: [],
      validator: z.object({ channel: z.string().optional() })
    })
    expect(text).toContain('Accepted arguments: { channel?: string }')
  })
})
