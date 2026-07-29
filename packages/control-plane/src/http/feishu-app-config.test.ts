import { describe, expect, it, vi } from 'vitest'
import { createFeishuHttpAppConfigurator } from './feishu-app-config.js'

describe('configureFeishuHttpApp', () => {
  it('sets webhook delivery, callback URL, and verification keys on the Lark app', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: 'tenant-token' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0 })))

    await createFeishuHttpAppConfigurator(fetcher)({
      appId: 'cli_oneclick',
      appSecret: 'app-secret',
      region: 'lark',
      requestUrl: 'https://relay.example/feishu/events',
      verificationToken: 'verification-token',
      encryptKey: 'encrypt-key'
    })

    expect(fetcher.mock.calls[0]?.[0]).toBe('https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal')
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      'https://open.larksuite.com/open-apis/application/v7/applications/cli_oneclick/config'
    )
    const request = fetcher.mock.calls[1]?.[1]
    expect(request?.method).toBe('PATCH')
    expect(request?.headers).toMatchObject({ authorization: 'Bearer tenant-token' })
    expect(JSON.parse(String(request?.body))).toMatchObject({
      event: {
        subscription_type: 'webhook',
        request_url: 'https://relay.example/feishu/events',
        add_events: ['im.message.receive_v1']
      },
      callback: {
        callback_type: 'webhook',
        request_url: 'https://relay.example/feishu/events',
        add_callbacks: ['card.action.trigger']
      },
      event_and_callback_encrypt_strategy: {
        verification_token: 'verification-token',
        encryption_key: 'encrypt-key'
      }
    })
  })
})
