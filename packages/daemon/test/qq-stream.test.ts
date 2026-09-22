import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@tencent-connect/qqbot-nodejs/protocol'
import { QQPrivateStream } from '../src/platforms/qq/private-stream.js'
import { QQSender, splitQQText, type QQStreamCursor } from '../src/platforms/qq/sender.js'
import { QQConverger, applyQQAction, type QQTurnState } from '../src/platforms/qq/turn-output.js'

const update = (text: string, phase?: string, messageId?: string) => ({
  sessionUpdate: 'agent_message_chunk' as const,
  content: { type: 'text' as const, text },
  ...(phase ? { _meta: { codex: { phase } } } : {}),
  ...(messageId ? { messageId } : {})
})

function fixture() {
  const sendText = vi.fn(async (_channel: string, _reply: string, _text: string) => {})
  const sendStream = vi.fn(
    async (_channel: string, _reply: string, cursor: QQStreamCursor, _text: string, _done: boolean) => {
      cursor.id ??= 'stream-id'
    }
  )
  const stream = new QQPrivateStream({ sendText, sendStream }, 'dm:u', 'incoming')
  return { stream, sendText, sendStream }
}

afterEach(() => vi.useRealTimers())

describe('QQ private streaming', () => {
  it('records the final before a failing delivery and never retries', async () => {
    const record = vi.fn(async () => {})
    const sendText = vi.fn(async () => {
      expect(record).toHaveBeenCalledWith('saved')
      throw new Error('timeout')
    })
    await expect(
      applyQQAction({ channel: 'dm:u', replyId: 'm', conn: { sendText } }, { kind: 'post', text: 'saved' }, record)
    ).rejects.toThrow('timeout')
    expect(sendText).toHaveBeenCalledTimes(1)
  })

  it('retains silent-mode results without delivering them', async () => {
    const c = new QQConverger('none')
    c.onUpdate(update('saved', 'final_answer'))
    const record = vi.fn(async () => {})
    const sendText = vi.fn()
    await applyQQAction({ channel: 'dm:u', replyId: 'm', conn: { sendText } }, c.onFinal()[0]!, record)
    expect(record).toHaveBeenCalledWith('saved')
    expect(sendText).not.toHaveBeenCalled()
  })

  it('coalesces token bursts, closes once, and never posts the final twice', async () => {
    vi.useFakeTimers()
    const { stream, sendStream, sendText } = fixture()
    stream.update('hello')
    stream.update('hello world')
    await vi.advanceTimersByTimeAsync(1000)
    expect(sendStream).toHaveBeenCalledTimes(1)
    expect(sendStream.mock.calls[0]?.slice(3, 5)).toEqual(['hello world', false])
    stream.update('hello world!')
    await stream.finish('hello world!')
    await stream.close()
    await vi.advanceTimersByTimeAsync(2000)
    expect(sendStream).toHaveBeenCalledTimes(2)
    expect(sendStream.mock.calls[1]?.slice(3, 5)).toEqual(['hello world!', true])
    expect(sendText).not.toHaveBeenCalled()
  })

  it('sends short answers through the ordinary Markdown message path', async () => {
    vi.useFakeTimers()
    const { stream, sendStream, sendText } = fixture()
    stream.update('short')
    await stream.finish('short')
    await stream.close()
    await vi.advanceTimersByTimeAsync(2000)
    expect(sendStream).not.toHaveBeenCalled()
    expect(sendText).toHaveBeenCalledExactlyOnceWith('dm:u', 'incoming', 'short')
  })

  it('falls back only when the first stream is explicitly refused', async () => {
    vi.useFakeTimers()
    const { stream, sendStream, sendText } = fixture()
    sendStream.mockRejectedValue(new ApiError('unsupported', 403, '/stream_messages'))
    stream.update('answer')
    await vi.advanceTimersByTimeAsync(1000)
    await stream.finish('answer completed')
    expect(sendStream).toHaveBeenCalledTimes(1)
    expect(sendText).toHaveBeenCalledExactlyOnceWith('dm:u', 'incoming', 'answer completed')
  })

  it('retains the complete transcript after ambiguous delivery without retrying', async () => {
    vi.useFakeTimers()
    const sendText = vi.fn()
    const sendStream = vi.fn().mockRejectedValue(new Error('timeout'))
    const state: QQTurnState = { channel: 'dm:u', replyId: 'm', conn: { sendText, sendStream } }
    const record = vi.fn(async () => {})
    await applyQQAction(state, { kind: 'qq-stream', text: 'hello' }, record)
    await vi.advanceTimersByTimeAsync(1000)
    await expect(applyQQAction(state, { kind: 'post', text: 'hello world' }, record)).rejects.toThrow('timeout')
    await state.stream!.close()
    expect(record).toHaveBeenCalledExactlyOnceWith('hello world')
    expect(sendStream).toHaveBeenCalledTimes(1)
    expect(sendText).not.toHaveBeenCalled()
  })

  it('does not fall back after any frame was accepted', async () => {
    vi.useFakeTimers()
    const { stream, sendStream, sendText } = fixture()
    stream.update('hello')
    await vi.advanceTimersByTimeAsync(1000)
    sendStream.mockRejectedValue(new ApiError('expired', 403, '/stream_messages'))
    await expect(stream.finish('hello world')).rejects.toThrow('expired')
    await stream.close()
    expect(sendStream).toHaveBeenCalledTimes(2)
    expect(sendText).not.toHaveBeenCalled()
  })

  it('suppression cancels pending text and closes only the confirmed snapshot', async () => {
    vi.useFakeTimers()
    const { stream, sendStream } = fixture()
    stream.update('visible')
    await vi.advanceTimersByTimeAsync(1000)
    stream.update('visible but suppressed')
    stream.suppress()
    await stream.close()
    await vi.advanceTimersByTimeAsync(2000)
    expect(sendStream.mock.calls.map((call) => call.slice(3, 5))).toEqual([
      ['visible', false],
      ['visible', true]
    ])
  })

  it('waits for the in-flight frame before finalizing', async () => {
    vi.useFakeTimers()
    const { stream, sendStream } = fixture()
    let release!: () => void
    sendStream.mockImplementationOnce(async (_channel, _reply, cursor) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      cursor.id = 'stream-id'
    })
    stream.update('start')
    await vi.advanceTimersByTimeAsync(1000)
    const finish = stream.finish('start end')
    expect(sendStream).toHaveBeenCalledTimes(1)
    release()
    await finish
    expect(sendStream.mock.calls[1]?.slice(3, 5)).toEqual(['start end', true])
  })

  it('delivers a long Unicode suffix without retracting the visible prefix', async () => {
    vi.useFakeTimers()
    const { stream, sendStream, sendText } = fixture()
    const prefix = 'first line\n' + '字'.repeat(1000)
    const full = prefix + '😀'.repeat(1500)
    stream.update(prefix)
    await vi.advanceTimersByTimeAsync(1000)
    stream.update(full)
    await stream.finish(full)
    const finalPrefix = sendStream.mock.calls.at(-1)![3]
    expect(finalPrefix.startsWith(prefix)).toBe(true)
    expect(finalPrefix + sendText.mock.calls[0]![2]).toBe(full)
  })
})

describe('QQ common sender', () => {
  it('sends Markdown through the QQ message type rather than literal plain text', async () => {
    const request = vi.fn().mockResolvedValue({ id: 'message' })
    const sender = new QQSender({ request }, async () => 'token', new AbortController().signal)
    const body = '# Title\n\n**Bold** and `code`\n\n```ts\nconst value = 1\n```'
    await sender.sendText({ kind: 'c2c', id: 'u' }, 'm', body)
    expect(request).toHaveBeenCalledExactlyOnceWith('token', 'POST', '/v2/users/u/messages', {
      msg_type: 2,
      markdown: { content: body },
      msg_id: 'm',
      msg_seq: 1
    })
  })

  it('logs a definite Markdown permission refusal before falling back once', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('do not log this body', 403, '/messages', 123))
      .mockResolvedValueOnce({ id: 'message' })
    const warn = vi.fn()
    const sender = new QQSender({ request }, async () => 'token', new AbortController().signal, warn)
    await sender.sendText({ kind: 'c2c', id: 'u' }, 'm', '**answer**')
    expect(request.mock.calls.map((call) => call[3])).toEqual([
      { msg_type: 2, markdown: { content: '**answer**' }, msg_id: 'm', msg_seq: 1 },
      { msg_type: 0, content: '**answer**', msg_id: 'm', msg_seq: 2 }
    ])
    expect(warn).toHaveBeenCalledExactlyOnceWith('qq: Markdown delivery refused (HTTP 403, code 123); using plain text')
  })

  it.each([new Error('timeout'), new ApiError('rate limited', 429, '/messages')])(
    'does not send another format after an uncertain or rate-limited request',
    async (error) => {
      const request = vi.fn().mockRejectedValue(error)
      const sender = new QQSender({ request }, async () => 'token', new AbortController().signal)
      await expect(sender.sendText({ kind: 'c2c', id: 'u' }, 'm', 'answer')).rejects.toBe(error)
      expect(request).toHaveBeenCalledTimes(1)
    }
  )

  it('serializes a conversation while allowing another target to send', async () => {
    let release!: () => void
    const request = vi.fn(async (_token, _method, path: string) => {
      if (path.includes('/a/'))
        await new Promise<void>((resolve) => {
          release = resolve
        })
      return { id: 'id' }
    })
    const sender = new QQSender({ request: request as any }, async () => 'token', new AbortController().signal)
    const first = sender.sendText({ kind: 'c2c', id: 'a' }, 'm', 'one')
    const second = sender.sendText({ kind: 'c2c', id: 'a' }, 'm', 'two')
    await sender.sendText({ kind: 'c2c', id: 'b' }, 'm', 'other')
    expect(request).toHaveBeenCalledTimes(2)
    release()
    await first
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3))
    release()
    await second
  })

  it('uses one sequence per stream, monotonic indices and an independent next message sequence', async () => {
    const request = vi.fn().mockResolvedValue({ id: 'stream' })
    const sender = new QQSender({ request }, async () => 'token', new AbortController().signal)
    const target = { kind: 'c2c' as const, id: 'u' }
    const cursor: QQStreamCursor = { index: 0 }
    await sender.sendStream(target, 'm', cursor, 'a', false)
    await sender.sendStream(target, 'm', cursor, 'ab', true)
    await sender.sendText(target, 'm', 'next')
    expect(request.mock.calls.map((call) => call[3].msg_seq)).toEqual([1, 1, 2])
    expect(request.mock.calls.slice(0, 2).map((call) => call[3].index)).toEqual([0, 1])
    expect(request.mock.calls.slice(0, 2).map((call) => call[3].event_id)).toEqual(['m', 'm'])
    expect(request.mock.calls[1]![3].stream_msg_id).toBe('stream')
    expect(request.mock.calls[1]![3].input_state).toBe(10)
  })

  it('cancels a stream frame waiting behind another send', async () => {
    let release!: () => void
    const request = vi.fn().mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { id: 'first' }
    })
    const sender = new QQSender({ request }, async () => 'token', new AbortController().signal)
    const target = { kind: 'c2c' as const, id: 'u' }
    const first = sender.sendText(target, 'm', 'first')
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    const abort = new AbortController()
    const next = sender.sendStream(target, 'm', { index: 0 }, 'suppressed', false, abort.signal)
    abort.abort()
    const rejected = expect(next).rejects.toThrow()
    release()
    await first
    await rejected
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('does not send a queued write after the connection stops', async () => {
    const abort = new AbortController()
    const request = vi.fn()
    const sender = new QQSender({ request }, async () => 'token', abort.signal)
    abort.abort()
    await expect(sender.sendText({ kind: 'c2c', id: 'u' }, 'm', 'body')).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
  })

  it('splits at line boundaries without losing bytes or exceeding the limit', () => {
    const text = '一行\n' + '😀'.repeat(30)
    const parts = splitQQText(text, 40)
    expect(parts[0]).toBe('一行\n')
    expect(parts.join('')).toBe(text)
    expect(parts.every((part) => Buffer.byteLength(part) <= 40)).toBe(true)
    expect(splitQQText('\na😀', 5).every((part) => Buffer.byteLength(part) <= 5)).toBe(true)
  })
})

describe('QQ stream selection', () => {
  it.each([
    'Read [the guide](https://example.com) and continue',
    'Use `items[0] < 10` and continue',
    '```ts\nconst items = [1, 2]\n```\n\nContinue'
  ])('keeps streaming complete links and code: %s', (text) => {
    const converger = new QQConverger('high')
    expect(converger.onUpdate(update(text))[0]?.text).toBe(text)
    expect(converger.onUpdate(update(' with more details'))[0]?.text).toBe(`${text} with more details`)
    expect(converger.onFinal()[0]?.text).toBe(`${text} with more details`)
  })

  it('streams comparisons with a stable prefix when a later workspace link is rewritten', () => {
    const converger = new QQConverger('high', () => 'https://console.example/file')
    const first = converger.onUpdate(update('When x < 10, continue'))[0]?.text
    expect(first).toContain('10, continue')
    const next = converger.onUpdate(update(' in [source](/private/file.ts)'))[0]?.text
    expect(next).toContain('https://console.example/file')
    expect(next?.startsWith(first!)).toBe(true)
    expect(converger.onFinal()[0]?.text).toBe(next)
  })

  it('finishes a stream whose inline code and workspace link arrive in separate chunks', async () => {
    vi.useFakeTimers()
    const converger = new QQConverger('high', () => 'https://console.example/file')
    const { sendText, sendStream } = fixture()
    const state: QQTurnState = { channel: 'dm:u', replyId: 'm', conn: { sendText, sendStream } }
    const record = vi.fn(async () => {})
    for (const text of ['Use `x ', '< 10', '` and then ', '[source](/private/file.ts)']) {
      for (const action of converger.onUpdate(update(text))) await applyQQAction(state, action, record)
      await vi.advanceTimersByTimeAsync(1000)
    }
    for (const action of converger.onFinal()) await applyQQAction(state, action, record)
    await state.stream!.close()
    expect(sendStream.mock.lastCall?.slice(3, 5)).toEqual([
      'Use `x < 10` and then [source](<https://console.example/file>)',
      true
    ])
    expect(sendText).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'quoted attribute', text: 'Before <span title="hello">text</span> after.' },
    { name: 'multiline attributes', text: 'Before <span\n\tclass="note" >text</span> after.' },
    { name: 'angle bracket inside an attribute', text: 'Before <span title="a > b">text</span> after.' },
    { name: 'Markdown inside an attribute', text: 'Before <span title="*note*">text</span> after.' },
    { name: 'HTML comment', text: 'Before <!-- delayed comment --> after.' },
    { name: 'escaped opening bracket', text: 'Before \\<literal> after.' }
  ])('finishes fragmented HTML with a stable stream prefix: $name', async ({ text }) => {
    vi.useFakeTimers()
    const converger = new QQConverger('high')
    const { sendText, sendStream } = fixture()
    const state: QQTurnState = { channel: 'dm:u', replyId: 'm', conn: { sendText, sendStream } }
    const record = vi.fn(async () => {})
    for (const character of text) {
      for (const action of converger.onUpdate(update(character))) await applyQQAction(state, action, record)
      await vi.advanceTimersByTimeAsync(1000)
    }
    for (const action of converger.onFinal()) await applyQQAction(state, action, record)
    await state.stream!.close()
    expect(sendStream.mock.calls.every((call) => text.startsWith(call[3]))).toBe(true)
    expect(sendStream.mock.lastCall?.slice(3, 5)).toEqual([text, true])
    expect(sendStream.mock.calls.filter((call) => call[4])).toHaveLength(1)
    expect(record).toHaveBeenCalledExactlyOnceWith(text)
    expect(sendText).not.toHaveBeenCalled()
  })

  it('holds unresolved references but allows earlier paragraphs to stream', () => {
    const converger = new QQConverger('high')
    expect(converger.onUpdate(update('Introduction.\n\nSee [source]'))[0]?.text).toBe('Introduction.\n\n')
    expect(converger.onUpdate(update('\n\n[source]: /private/file.ts'))[0]?.text).toBe('Introduction.\n\n')
    expect(converger.onFinal()[0]?.text).not.toContain('/private/')
  })

  it('holds an incomplete autolink until its private target has been rewritten', () => {
    const converger = new QQConverger('high')
    const first = converger.onUpdate(update('See <fi'))[0]?.text
    expect(first).toBe('See ')
    expect(converger.onUpdate(update('le:/private/file.ts'))[0]?.text).toBe(first)
    const resolved = converger.onUpdate(update('> and continue'))[0]?.text
    expect(resolved).toContain('and continue')
    expect(resolved).not.toContain('/private/')
    expect(converger.onFinal()[0]?.text).toBe(resolved)
  })

  it('streams standard ACP text without phase metadata and excludes thought and commentary', () => {
    const converger = new QQConverger('high')
    expect(converger.onUpdate(update('thinking', 'commentary', 'commentary'))).toEqual([])
    expect(
      converger.onUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'secret' } })
    ).toEqual([])
    expect(converger.onUpdate(update('hello '))[0]?.text).toBe('hello ')
    expect(converger.onUpdate(update('world'))[0]?.text).toBe('hello world')
    expect(converger.onFinal()[0]?.text).toBe('hello world')
  })

  it('keeps phase-less text across tool boundaries in the same stream without a duplicate final', async () => {
    vi.useFakeTimers()
    const converger = new QQConverger('high')
    const { sendText, sendStream } = fixture()
    const record = vi.fn(async () => {})
    const state: QQTurnState = { channel: 'dm:u', replyId: 'm', conn: { sendText, sendStream } }
    for (const action of converger.onUpdate(update('Checking now.'))) await applyQQAction(state, action, record)
    await vi.advanceTimersByTimeAsync(1000)
    for (const action of converger.onUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 't',
      title: 'Private tool title'
    }))
      await applyQQAction(state, action, record)
    for (const action of converger.onUpdate({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Private reasoning' }
    }))
      await applyQQAction(state, action, record)
    for (const action of converger.onUpdate(update('**Result**'))) await applyQQAction(state, action, record)
    await vi.advanceTimersByTimeAsync(1000)
    for (const action of converger.onFinal()) await applyQQAction(state, action, record)
    await state.stream!.close()
    expect(sendStream.mock.calls.map((call) => call.slice(3, 5))).toEqual([
      ['Checking now.', false],
      ['Checking now.\n\n**Result**', false],
      ['Checking now.\n\n**Result**', true]
    ])
    expect(record).toHaveBeenCalledExactlyOnceWith('Checking now.\n\n**Result**')
    expect(sendText).not.toHaveBeenCalled()
  })

  it('preserves distinct phase-less messages and releases resolved links at a block boundary', () => {
    const converger = new QQConverger('high', () => 'https://console.example/file')
    converger.onUpdate(update('See [source](/private/file.ts)', undefined, 'first'))
    expect(converger.onUpdate(update('Next answer', undefined, 'second'))[0]?.text).toBe(
      'See [source](<https://console.example/file>)\n\nNext answer'
    )
    expect(converger.onFinal()[0]?.text).toBe('See [source](<https://console.example/file>)\n\nNext answer')
  })

  it('does not stream the no-response sentinel or emit explicit commentary at completion', () => {
    const converger = new QQConverger('high')
    expect(converger.onUpdate(update('AC_NO_'))).toEqual([])
    expect(converger.onUpdate(update('RESPONSE'))).toEqual([])
    expect(converger.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 't', title: 'tool' })).toEqual([])
    expect(converger.onUpdate(update('working', 'commentary'))).toEqual([])
    expect(converger.onFinal()).toEqual([])
  })

  it('preserves late phase classification and multiple final message ids', () => {
    const converger = new QQConverger('high')
    converger.onUpdate(update('hello ', undefined, 'first'))
    expect(converger.onUpdate(update('world', 'final_answer', 'first'))[0]?.text).toBe('hello world')
    expect(converger.onUpdate(update('next', 'final_answer', 'second'))[0]?.text).toBe('hello world\n\nnext')
    expect(converger.onFinal()[0]?.text).toBe('hello world\n\nnext')
  })

  it('holds partial links and resolves the final workspace link', () => {
    const converger = new QQConverger('high', () => 'https://console.example/file')
    const first = converger.onUpdate(update('See [source](/home/private', 'final_answer'))
    expect(first).toEqual([])
    converger.onUpdate(update('/file.ts)', 'final_answer'))
    expect(converger.onFinal()[0]?.text).toContain('https://console.example/file')
    expect(converger.onFinal()).toEqual([])
  })

  it('keeps cancellation output and finalization idempotent', () => {
    const converger = new QQConverger('high')
    converger.onUpdate(update('partial', 'final_answer'))
    expect(converger.flushTerminal()[0]?.text).toBe('partial')
    expect(converger.onFinal()).toEqual([])
    expect(converger.onUpdate(update('late', 'final_answer'))).toEqual([])
  })
})
