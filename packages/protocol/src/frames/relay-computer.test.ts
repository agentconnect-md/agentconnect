import { describe, expect, it } from 'vitest'
import {
  MAX_FRAME_BYTES,
  RELAY_COMPUTER_MAX_FRAME_BYTES,
  buildRelayComputerFrame,
  decodeRelayComputerFrame,
  relayComputerMcpUrl,
  relayComputerWsUrl
} from '../index.js'

const COMPUTER = '00000000-0000-4000-8000-000000000001'

describe('relay ↔ desktop wire', () => {
  it('derives the desktop dial-in and the agent entry from a roster url, keeping an instance path prefix', () => {
    expect(relayComputerWsUrl('wss://relay-0.example.com/rd/ws')).toBe('wss://relay-0.example.com/cr/ws')
    expect(relayComputerWsUrl('ws://10.0.0.5:8080/rd/ws')).toBe('ws://10.0.0.5:8080/cr/ws')
    expect(relayComputerWsUrl('wss://relays.example.com/relay-1/rd/ws')).toBe('wss://relays.example.com/relay-1/cr/ws')
    expect(relayComputerMcpUrl('wss://relay-0.example.com/rd/ws', COMPUTER)).toBe(
      `https://relay-0.example.com/cr/computers/${COMPUTER}/mcp`
    )
    expect(relayComputerMcpUrl('ws://10.0.0.5:8080/relay-1/rd/ws', COMPUTER)).toBe(
      `http://10.0.0.5:8080/relay-1/cr/computers/${COMPUTER}/mcp`
    )
  })

  it('round-trips its frames and carries a body larger than the control wires allow', () => {
    const body = Buffer.alloc(MAX_FRAME_BYTES * 2, 7).toString('base64')
    const frames = [
      buildRelayComputerFrame('cr/hello', { computerId: COMPUTER, token: 'actk1.a.b', desktopDaemonVersion: '0.1.0' }),
      buildRelayComputerFrame('cr/hello/ok', { relayId: 'relay-1' }),
      buildRelayComputerFrame('cr/http', {
        method: 'POST',
        path: '/mcp',
        headers: { authorization: 'Bearer x' },
        body
      }),
      buildRelayComputerFrame('cr/http/result', { status: 200, headers: { 'content-type': 'application/json' }, body }),
      buildRelayComputerFrame('error', { code: 'AUTH_FAILED', message: 'no', retryable: true })
    ]
    for (const frame of frames) expect(decodeRelayComputerFrame(JSON.stringify(frame)).ok, frame.type).toBe(true)
  })

  it('refuses a frame over its own ceiling and a hello with extra fields', () => {
    const huge = 'A'.repeat(RELAY_COMPUTER_MAX_FRAME_BYTES)
    const frame = buildRelayComputerFrame('cr/http/result', { status: 200, headers: {}, body: huge })
    expect(decodeRelayComputerFrame(JSON.stringify(frame))).toMatchObject({ ok: false, msg: 'FRAME_TOO_LARGE' })
    const hello = buildRelayComputerFrame('cr/hello', {
      computerId: COMPUTER,
      token: 't',
      desktopDaemonVersion: '0.1.0',
      apiKey: 'leak'
    } as never)
    expect(decodeRelayComputerFrame(JSON.stringify(hello)).ok).toBe(false)
  })
})
