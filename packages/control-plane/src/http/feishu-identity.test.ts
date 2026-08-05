import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFeishuAppTenantGuard, resolveFeishuAppTenant, verifyFeishuBot } from './feishu-identity.js'

/** Capture every fetch URL and answer the two-step verify flow (token exchange, then
 *  bot/info) with success, so we can assert WHICH host the verifier dialed. */
function stubFetch(urls: string[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url)
      const body = url.includes('tenant_access_token')
        ? { code: 0, tenant_access_token: 'tkn' }
        : { code: 0, bot: { app_name: 'Acme', open_id: 'ou_bot' } }
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
    expect(r).toEqual({ status: 'ok', name: 'Acme', openId: 'ou_bot' })
    expect(urls.every((u) => u.startsWith('https://open.feishu.cn/open-apis'))).toBe(true)
  })

  it("uses the Lark (open.larksuite.com) gateway when region is 'lark'", async () => {
    const urls: string[] = []
    stubFetch(urls)
    const r = await verifyFeishuBot('cli_x', 'secret', 'lark')
    expect(r).toEqual({ status: 'ok', name: 'Acme', openId: 'ou_bot' })
    expect(urls.length).toBeGreaterThan(0)
    expect(urls.every((u) => u.startsWith('https://open.larksuite.com/open-apis'))).toBe(true)
  })
})

describe('resolveFeishuAppTenant', () => {
  it('resolves the organization that owns a new Lark App', async () => {
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url)
        const body = url.includes('tenant_access_token')
          ? { code: 0, tenant_access_token: 'tenant-token' }
          : { code: 0, data: { tenant: { tenant_key: 'tenant_same_org' } } }
        return new Response(JSON.stringify(body))
      })
    )

    await expect(resolveFeishuAppTenant('cli_new', 'secret', 'lark')).resolves.toEqual({
      status: 'ok',
      tenantKey: 'tenant_same_org'
    })
    expect(urls[1]).toBe('https://open.larksuite.com/open-apis/tenant/v2/tenant/query')
  })

  it('compares every Bot App with one cached regional Login App tenant', async () => {
    const resolve = vi.fn(async (appId: string) => ({
      status: 'ok' as const,
      tenantKey: appId === 'cli_other' ? 'tenant_other' : 'tenant_same_org'
    }))
    const guard = createFeishuAppTenantGuard(() => ({ appId: 'cli_login', appSecret: 'login-secret' }), resolve)

    await expect(guard.checkApp('cli_bot', 'bot-secret', 'lark')).resolves.toBe('ok')
    await expect(guard.checkApp('cli_other', 'other-secret', 'lark')).resolves.toBe('org_mismatch')
    expect(resolve.mock.calls.filter(([appId]) => appId === 'cli_login')).toHaveLength(1)
  })
})
