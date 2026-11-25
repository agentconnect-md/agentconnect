import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import { filterJsonBody, judgeRequest, SseToolsListFilter, TOOLS_LIST_BUFFER_LIMIT } from './tool-policy.js'

const decisions = { allow: new Set(['read_note']) }
const body = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))
const call = (id: number, name: unknown) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: {} }
})
const tools = [{ name: 'read_note' }, { name: 'write_note' }, { name: 'delete_note' }]

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  let out = ''
  for await (const chunk of stream) out += chunk.toString()
  return out
}

describe('judgeRequest', () => {
  it('forwards an allowed call as the re-serialized message, not the original bytes', () => {
    const raw =
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"write_note"},"params":{"name":"read_note"}}'
    const judgment = judgeRequest(body(raw), decisions)
    expect(judgment.kind).toBe('forward')
    if (judgment.kind !== 'forward') return
    // Duplicate keys resolve once, here; the upstream sees exactly what was judged.
    expect(JSON.parse(judgment.body).params).toEqual({ name: 'read_note' })
    expect(judgment.body).not.toContain('write_note')
  })

  it('answers a blocked call itself, with a tool result the model can read', () => {
    const judgment = judgeRequest(body(call(7, 'write_note')), decisions)
    expect(judgment).toMatchObject({ kind: 'respond', status: 200, refused: ['write_note'] })
    if (judgment.kind !== 'respond') return
    expect(judgment.json).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { content: [{ type: 'text', text: 'The tool "write_note" is blocked for this agent.' }], isError: true }
    })
  })

  it('refuses a call without a usable tool name', () => {
    expect(judgeRequest(body(call(1, 42)), decisions)).toMatchObject({ kind: 'respond', refused: ['(unnamed)'] })
    expect(judgeRequest(body({ jsonrpc: '2.0', id: 1, method: 'tools/call' }), decisions)).toMatchObject({
      kind: 'respond',
      refused: ['(unnamed)']
    })
  })

  it('answers a whole batch when any member is blocked, and forwards a batch with none', () => {
    const mixed = judgeRequest(
      body([call(1, 'read_note'), call(2, 'write_note'), { jsonrpc: '2.0', method: 'notifications/initialized' }]),
      decisions
    )
    expect(mixed.kind).toBe('respond')
    if (mixed.kind !== 'respond') return
    const answers = mixed.json as Array<{ id: number; error?: unknown; result?: { isError?: boolean } }>
    expect(answers.map((answer) => answer.id)).toEqual([1, 2])
    expect(answers[0]!.error).toBeDefined()
    expect(answers[1]!.result?.isError).toBe(true)
    expect(judgeRequest(body([call(1, 'read_note')]), decisions).kind).toBe('forward')
  })

  it('records the ids of tools/list requests so their responses are filtered', () => {
    const judgment = judgeRequest(
      body([
        { jsonrpc: '2.0', id: 'a', method: 'tools/list' },
        { jsonrpc: '2.0', id: 3, method: 'tools/list', params: { cursor: 'c' } }
      ]),
      decisions
    )
    if (judgment.kind !== 'forward') throw new Error('expected forward')
    expect([...judgment.listIds].sort()).toEqual(['"a"', '3'])
  })

  it('fails closed on unparseable or malformed bodies', () => {
    expect(judgeRequest(body('{not json'), decisions)).toMatchObject({ kind: 'respond', status: 400 })
    expect(judgeRequest(body('[]'), decisions)).toMatchObject({ kind: 'respond', status: 400 })
    expect(judgeRequest(body('[1]'), decisions)).toMatchObject({ kind: 'respond', status: 400 })
    expect(judgeRequest(body('"text"'), decisions)).toMatchObject({ kind: 'respond', status: 400 })
  })

  it('forwards everything else, including responses to server requests', () => {
    expect(judgeRequest(body({ jsonrpc: '2.0', id: 1, method: 'resources/read' }), decisions).kind).toBe('forward')
    expect(judgeRequest(body({ jsonrpc: '2.0', id: 'srv-1', result: { action: 'accept' } }), decisions).kind).toBe(
      'forward'
    )
    expect(judgeRequest(undefined, decisions).kind).toBe('forward')
  })
})

describe('filterJsonBody', () => {
  it('keeps only allowed tools in a listed response and leaves other messages alone', () => {
    const out = JSON.parse(
      filterJsonBody(
        JSON.stringify([
          { jsonrpc: '2.0', id: 1, result: { tools, nextCursor: 'n' } },
          { jsonrpc: '2.0', id: 2, result: { tools } }
        ]),
        decisions,
        new Set(['1'])
      )
    )
    expect(out[0].result).toEqual({ tools: [{ name: 'read_note' }], nextCursor: 'n' })
    expect(out[1].result.tools).toHaveLength(3)
  })

  it('turns anything it cannot filter into an error, never unfiltered data', () => {
    expect(JSON.parse(filterJsonBody('<html>', decisions, new Set(['1'])))).toMatchObject({ id: 1, error: {} })
    expect(
      JSON.parse(
        filterJsonBody(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: 'x' } }), decisions, new Set(['1']))
      )
    ).toMatchObject({ id: 1, error: {} })
    // An upstream error passes through: it lists nothing.
    const error = { jsonrpc: '2.0', id: 1, error: { code: -1, message: 'nope' } }
    expect(JSON.parse(filterJsonBody(JSON.stringify(error), decisions, new Set(['1'])))).toEqual(error)
  })
})

describe('SseToolsListFilter', () => {
  it('rewrites only the event answering a listed id, across chunk boundaries', async () => {
    const listed = `event: message\nid: 9\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools } })}\n\n`
    const other = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress' })}\n\n`
    const text = other + listed
    const chunks = [text.slice(0, 17), text.slice(17, 120), text.slice(120)].map((part) => Buffer.from(part))
    const out = await collect(Readable.from(chunks).pipe(new SseToolsListFilter(decisions, new Set(['1']))))
    expect(out.startsWith(other)).toBe(true)
    expect(out).toContain('id: 9')
    expect(out).toContain('"name":"read_note"')
    expect(out).not.toContain('write_note')
  })

  it('drops an event that never ends, as a client would', async () => {
    const unterminated = `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools } })}`
    const out = await collect(
      Readable.from([Buffer.from(unterminated)]).pipe(new SseToolsListFilter(decisions, new Set(['1'])))
    )
    expect(out).toBe('')
  })

  it('ends with an error instead of buffering an oversized event', async () => {
    const huge = Buffer.from(`data: ${'x'.repeat(TOOLS_LIST_BUFFER_LIMIT + 10)}`)
    const out = await collect(Readable.from([huge]).pipe(new SseToolsListFilter(decisions, new Set(['1']))))
    expect(out).toContain('too large to filter')
    expect(out).not.toContain('xxxx')
  })
})
