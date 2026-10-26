// A fake iLink bot API and CDN behind `fetch`: scripted poll answers, recorded sends, and encrypted media.
import { createCipheriv } from 'node:crypto'

export const API = 'https://ilink.example.test'
export const CDN = 'https://cdn.example.test/c2c'

/** One scripted getupdates answer: a body, a refusal code, an HTTP status, or a transport failure. */
export type PollStep =
  | { msgs?: unknown[]; get_updates_buf?: string; longpolling_timeout_ms?: number }
  | { ret: number }
  | { status: number }
  | { throws: 'network' }

export interface IlinkCall {
  path: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

export function encryptMedia(plain: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(plain), cipher.final()])
}

function rawJson(text: string, status = 200): Response {
  return new Response(text, { status, headers: { 'content-type': 'application/json' } })
}

// Resolves when the request is aborted, as a long poll the server is still holding does.
function held(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const fail = () => reject(signal?.reason ?? new DOMException('aborted', 'AbortError'))
    if (signal?.aborted) return fail()
    signal?.addEventListener('abort', fail, { once: true })
  })
}

export function fakeIlink(
  opts: {
    polls?: PollStep[]
    /** Per send, in order: a refusal code, a timeout, or (default) success. */
    sends?: ('ok' | 'timeout' | { ret: number })[]
    media?: Map<string, Buffer>
  } = {}
) {
  const calls: IlinkCall[] = []
  const polls = [...(opts.polls ?? [])]
  const sends = [...(opts.sends ?? [])]
  let sent = 0
  let pollsAnswered = 0
  const idle: (() => void)[] = []
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = String(url)
    if (href.startsWith(CDN)) {
      const bytes = opts.media?.get(href)
      return bytes ? new Response(new Uint8Array(bytes)) : new Response('missing', { status: 404 })
    }
    const path = href.slice(API.length + 1)
    calls.push({
      path,
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>
    })
    if (path === 'ilink/bot/getupdates') {
      const step = polls.shift()
      if (!step) {
        for (const wake of idle.splice(0)) wake()
        return held(init?.signal)
      }
      pollsAnswered++
      if ('throws' in step) throw new TypeError('fetch failed')
      if ('status' in step) return rawJson('{}', step.status)
      return rawJson(JSON.stringify(step))
    }
    if (path === 'ilink/bot/sendmessage') {
      sent++
      const step = sends.shift() ?? 'ok'
      if (step === 'timeout') throw new DOMException('The operation timed out.', 'TimeoutError')
      if (step !== 'ok') return rawJson(JSON.stringify(step))
      // An id above 2^53, written as a bare JSON number the way iLink writes it.
      return rawJson(`{"message_id":725491739104856${2000 + sent}}`)
    }
    return rawJson('{"ret":0}')
  }
  return {
    calls,
    fetchImpl: fetchImpl as typeof fetch,
    sendCalls: () => calls.filter((call) => call.path === 'ilink/bot/sendmessage'),
    pollCalls: () => calls.filter((call) => call.path === 'ilink/bot/getupdates'),
    get pollsAnswered() {
      return pollsAnswered
    },
    /** Resolves once every scripted poll was answered and the poller is holding the next one. */
    drained: () => new Promise<void>((resolve) => idle.push(resolve))
  }
}
