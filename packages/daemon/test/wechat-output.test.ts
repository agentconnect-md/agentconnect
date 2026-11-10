import { describe, expect, it, vi } from 'vitest'
import { decryptWeChatMedia, downloadWeChatMedia, weChatMediaKey } from '../src/platforms/wechat/media.js'
import { splitWeChatText, weChatPlainText, WECHAT_TEXT_MAX_CHARS } from '../src/platforms/wechat/text.js'
import { applyWeChatAction, WeChatConverger, type WeChatTurnHost } from '../src/platforms/wechat/turn-output.js'
import type { WeChatReplyPort, WeChatSendOptions, WeChatSentPart } from '../src/platforms/wechat/connection.js'
import { weChatPlatformModule } from '../src/platforms/wechat/module.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { CDN, encryptMedia } from './fakes/ilink-server.js'

const KEY = Buffer.from('00112233445566778899aabbccddeeff', 'hex')

describe('plain-text rendering', () => {
  it('reduces headings, emphasis, code fences and lists to their text', () => {
    const markdown = [
      '# Result',
      'The **build** is _green_ and `pnpm test` passes.',
      '```ts\nconst x = 1\n```',
      '- one\n- two',
      '1. first\n2. second',
      '> quoted line',
      '---',
      'See [the run](https://ci.example.test/run/1) or https://example.test.'
    ].join('\n\n')
    expect(weChatPlainText(markdown)).toBe(
      [
        'Result',
        'The build is green and pnpm test passes.',
        'const x = 1',
        '- one\n- two',
        '1. first\n2. second',
        '> quoted line',
        'See the run (https://ci.example.test/run/1) or https://example.test.'
      ].join('\n\n')
    )
  })

  it('packs whole paragraphs under the limit and cuts only a paragraph that alone exceeds it', () => {
    const paragraphs = ['a'.repeat(1200), 'b'.repeat(700), 'c'.repeat(900)]
    expect(splitWeChatText(paragraphs.join('\n\n')).map((part) => part.length)).toEqual([1200 + 2 + 700, 900])
    const huge = 'x'.repeat(WECHAT_TEXT_MAX_CHARS * 2 + 10)
    const parts = splitWeChatText(huge)
    expect(parts.map((part) => part.length)).toEqual([2000, 2000, 10])
    expect(parts.join('')).toBe(huge)
    expect(splitWeChatText('   ')).toEqual([])
  })

  it('renders reference-style links and images like inline ones', () => {
    const markdown = [
      'See [the run][r] and ![build badge][b].',
      '[r]: https://ci.example.test/run/1',
      '[b]: https://ci.example.test/badge.svg'
    ].join('\n\n')
    expect(weChatPlainText(markdown)).toBe('See the run (https://ci.example.test/run/1) and build badge.')
  })

  it('never splits a surrogate pair across two parts', () => {
    const parts = splitWeChatText(`${'a'.repeat(WECHAT_TEXT_MAX_CHARS - 1)}😀b`)
    expect(parts).toEqual(['a'.repeat(WECHAT_TEXT_MAX_CHARS - 1), '😀b'])
    for (const part of parts)
      expect(part).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  })
})

describe('media decryption', () => {
  it('reads a raw hex key, base64 of 16 bytes and base64 of 32 hex characters as the same key', () => {
    expect(weChatMediaKey({ aesKeyHex: KEY.toString('hex') })).toEqual(KEY)
    expect(weChatMediaKey({ aesKey: KEY.toString('base64') })).toEqual(KEY)
    expect(weChatMediaKey({ aesKey: Buffer.from(KEY.toString('hex')).toString('base64') })).toEqual(KEY)
    expect(weChatMediaKey({ aesKey: Buffer.from('short').toString('base64') })).toBeUndefined()
    expect(weChatMediaKey({ aesKeyHex: 'not-hex' })).toBeUndefined()
  })

  it('refuses a wrong key and bad padding instead of returning garbage', () => {
    const cipher = encryptMedia(Buffer.from('hello world'), KEY)
    expect(decryptWeChatMedia(cipher, KEY)?.toString()).toBe('hello world')
    expect(decryptWeChatMedia(cipher, Buffer.alloc(16, 7))).toBeUndefined()
    expect(decryptWeChatMedia(cipher.subarray(0, 15), KEY)).toBeUndefined()
    expect(decryptWeChatMedia(Buffer.alloc(16), KEY)).toBeUndefined()
  })

  it('downloads within the size limit and holds an image to image bytes', async () => {
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32)])
    const url = `${CDN}/download?encrypted_query_param=img`
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(encryptMedia(png, KEY)))) as unknown as typeof fetch
    const deps = { cdnUrl: CDN, signal: new AbortController().signal, fetchImpl }
    const ref = { ref: 'wechat-media:1:0', encryptQueryParam: 'img', aesKey: KEY.toString('base64'), image: true }
    expect(await downloadWeChatMedia(deps, ref, 1024)).toEqual(png)
    expect(String(vi.mocked(fetchImpl).mock.calls[0]![0])).toBe(url)
    const reasons: string[] = []
    expect(await downloadWeChatMedia(deps, ref, 8, (r) => void reasons.push(r))).toBeNull()
    const notImage = vi.fn(async () => new Response(new Uint8Array(encryptMedia(Buffer.from('text'), KEY))))
    expect(
      await downloadWeChatMedia(
        { ...deps, fetchImpl: notImage as unknown as typeof fetch },
        ref,
        1024,
        (r) => void reasons.push(r)
      )
    ).toBeNull()
    expect(
      await downloadWeChatMedia(
        deps,
        { ...ref, fullUrl: 'http://plain.example.test/x' },
        1024,
        (r) => void reasons.push(r)
      )
    ).toBeNull()
    expect(reasons).toEqual(['size_limit', 'unsupported_format', 'invalid_reference'])
  })
})

describe('WeChat turn output', () => {
  const turn = {
    plan: { transcriptChannel: 'transcript', statusThread: 'dm', agentId: 'agent', sessionKey: 'session' }
  }
  const setup = (sent: WeChatSentPart[]) => {
    const rows: { text: string; thread: string }[] = []
    let local = 0
    const host: WeChatTurnHost = {
      appendTranscript: async (row) => void rows.push({ text: row.text, thread: row.thread }),
      monotonicTs: () => `local-${++local}`
    }
    const conn = {
      sendText: vi.fn(async (_channel: string, _text: string, _options?: WeChatSendOptions) => sent)
    } satisfies WeChatReplyPort
    return { rows, host, conn }
  }

  it('posts only the completed answer, with no hint, and records it without sending in none mode', () => {
    expect(new WeChatConverger('low').onFinal()).toEqual([])
    const none = new WeChatConverger('none')
    none.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } } as never)
    expect(none.onFinal()).toEqual([{ kind: 'post', text: 'Done.', attributed: false, recordOnly: true }])
    const low = new WeChatConverger('low')
    low.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } } as never)
    expect(low.onFinal()).toEqual([{ kind: 'post', text: 'Done.', attributed: false }])
    expect(low.hasStreamingUpdate()).toBe(false)
  })

  it('records every part of an answer, sent or not, and sends a notice without recording it', async () => {
    const { rows, host, conn } = setup([
      { text: 'part one', messageId: '1' },
      { text: 'part two', error: new Error('x') }
    ])
    await applyWeChatAction(host, turn, { conn, channel: 'dm:u' }, { kind: 'post', text: 'whole' })
    expect(conn.sendText).toHaveBeenCalledWith('dm:u', 'whole', { stopped: expect.any(Function) })
    expect(rows).toEqual([
      { text: 'part one', thread: 'dm' },
      { text: 'part two', thread: 'dm' }
    ])
    await applyWeChatAction(host, turn, { conn, channel: 'dm:u' }, { kind: 'notice', text: 'Stopped.' })
    expect(conn.sendText).toHaveBeenLastCalledWith('dm:u', 'Stopped.')
    expect(rows).toHaveLength(2)
  })

  it('hands its sends a stop check that turns true once core cuts the turn', async () => {
    const { host, conn } = setup([])
    const live: typeof turn & { entry: { cancelledReason?: string }; outputSuppressed?: string } = {
      ...turn,
      entry: {}
    }
    await applyWeChatAction(host, live, { conn, channel: 'dm:u' }, { kind: 'post', text: 'whole' })
    const stopped = conn.sendText.mock.calls[0]![2]!.stopped!
    expect(stopped()).toBe(false)
    live.entry.cancelledReason = 'stop'
    expect(stopped()).toBe(true)
    live.entry.cancelledReason = undefined
    live.outputSuppressed = 'cut'
    expect(stopped()).toBe(true)
  })

  it('records without sending when headless or record-only', async () => {
    const { rows, host, conn } = setup([])
    await applyWeChatAction(host, turn, { conn, channel: 'dm:u' }, { kind: 'post', text: 'quiet', recordOnly: true })
    await applyWeChatAction(host, turn, { channel: 'dm:u' }, { kind: 'post', text: 'headless' })
    expect(conn.sendText).not.toHaveBeenCalled()
    expect(rows.map((row) => row.text)).toEqual(['quiet', 'headless'])
  })
})

describe('WeChat threading', () => {
  it('keeps the one chat in one session', async () => {
    const msg = { platform: 'wechat', channel: 'dm:u', isDm: true } as NormalizedMessage
    await weChatPlatformModule.canonicalizeThread!({} as never, msg, 'transcript')
    expect(msg.thread).toBe('dm')
  })
})
