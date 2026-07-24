import { afterEach, describe, expect, it, vi } from 'vitest'
import { verifyFeishuBot } from './feishu-identity.js'

/** Capture every fetch URL and answer the two-step verify flow (token exchange, then
 *  bot/info) with success, so we can assert WHICH host the verifier dialed. */
function stubFetch(urls: string[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url)
      const body = url.includes('tenant_access_token')
        ? { code: 0, tenant_access_token: 'tkn' }
        : { code: 0, bot: { app_name: 'Acme' } }
      return { ok: true, json: async () => body } as unknown as Response
    })
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('verifyFeishuBot gateway selection', () => {
  it('defaults to the Feishu (open.feishu.cn) gateway', async () => {
    const urls: string[] = []
    stubFetch(urls)
    const r = await verifyFeishuBot('cli_x', 'secret')
    expect(r).toEqual({ status: 'ok', name: 'Acme' })
    expect(urls.every((u) => u.startsWith('https://open.feishu.cn/open-apis'))).toBe(true)
  })

  it("uses the Lark (open.larksuite.com) gateway when region is 'lark'", async () => {
    const urls: string[] = []
    stubFetch(urls)
    const r = await verifyFeishuBot('cli_x', 'secret', 'lark')
    expect(r).toEqual({ status: 'ok', name: 'Acme' })
    expect(urls.length).toBeGreaterThan(0)
    expect(urls.every((u) => u.startsWith('https://open.larksuite.com/open-apis'))).toBe(true)
  })
})
