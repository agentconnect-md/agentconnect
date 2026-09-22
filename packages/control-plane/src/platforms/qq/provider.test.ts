import { describe, expect, it, vi } from 'vitest'
import { createQQCpProvider, verifyQQBot } from './provider.js'
import { buildCpPlatformRegistry } from '../registry.js'
import { buildCreateIntegrationBody } from '../../http/dto/create-integration-body.js'

const credentials = { appId: '100', appSecret: 'secret' }
describe('QQ installation', () => {
  it('distinguishes rejected credentials from provider unavailability', async () => {
    for (const [status, data, expected] of [
      [200, { access_token: 'token' }, true],
      [200, { errcode: 400 }, false],
      [503, {}, false]
    ] as const) {
      const result = await verifyQQBot(
        credentials,
        vi.fn(async () => new Response(JSON.stringify(data), { status }))
      )
      expect(result.ok).toBe(expected)
      if (!result.ok) expect(result.status).toBe(status === 503 ? 503 : 400)
    }
  })
  it('projects private credentials separately from the stable bot identity', async () => {
    const provider = createQQCpProvider()
    const install = provider.buildNewBotInstall({ credentials, identity: {}, transport: 'socket', shareable: false })
    expect(install.secrets).toEqual({ appToken: '100', botToken: 'secret', signingSecret: null })
    expect(install.externalIdentity?.externalAppId).toBe('100')
    expect(JSON.stringify(install.bot)).not.toContain('secret')
  })
  it('exposes the QQ credential block through the actual create schema', () => {
    const schema = buildCreateIntegrationBody(buildCpPlatformRegistry([createQQCpProvider()]))
    expect(
      schema.safeParse({ platform: 'qq', agentId: '00000000-0000-4000-8000-000000000001', qq: credentials }).success
    ).toBe(true)
  })
})
