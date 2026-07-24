import { describe, expect, it } from 'vitest'
import { hookIngressUrl } from './hooks.js'

describe('hookIngressUrl', () => {
  it('renders webhook ingress URLs as HTTP(S), even when PUBLIC_RELAY_URL is WS(S)', () => {
    expect(hookIngressUrl('wss://relay.test/', 'whk_tok')).toBe('https://relay.test/webhooks/in/whk_tok')
    expect(hookIngressUrl('ws://localhost:8090', 'whk_tok')).toBe('http://localhost:8090/webhooks/in/whk_tok')
    expect(hookIngressUrl('https://relay.test', 'whk_tok')).toBe('https://relay.test/webhooks/in/whk_tok')
  })
})
