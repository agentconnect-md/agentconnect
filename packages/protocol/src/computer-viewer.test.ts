import { describe, expect, it } from 'vitest'
import { relayComputerViewBase } from './computer-viewer.js'

const ID = '00000000-0000-4000-8000-000000000001'

describe('relayComputerViewBase', () => {
  it('builds the viewer API base from a public origin or a roster address', () => {
    expect(relayComputerViewBase('https://relay.example.com', ID)).toBe(
      `https://relay.example.com/cr/computers/${ID}/view/api`
    )
    expect(relayComputerViewBase('https://relay.example.com/', ID)).toBe(
      `https://relay.example.com/cr/computers/${ID}/view/api`
    )
    expect(relayComputerViewBase('wss://relay.example.com/i/relay-2/rd/ws?x=1', ID)).toBe(
      `https://relay.example.com/i/relay-2/cr/computers/${ID}/view/api`
    )
    expect(relayComputerViewBase('ws://127.0.0.1:8090/rd/ws', ID)).toBe(
      `http://127.0.0.1:8090/cr/computers/${ID}/view/api`
    )
  })
})
