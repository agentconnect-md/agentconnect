import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { checkDeployment } from '../src/check.js'
import { createSetupConfig, loadSetupConfig, SetupConfigSchema, writeSetupConfig } from '../src/config.js'
import { renderReport, reportExitCode } from '../src/report.js'

describe('setup config', () => {
  it('creates a localhost-only authenticated profile', () => {
    const config = createSetupConfig('local-auth')
    if (config.mode !== 'local-auth') throw new Error('expected local-auth config')
    expect(config.auth.issuer).toBe('http://login.agentconnect.localhost:3001/oidc')
    expect(config.services.web).toBe('http://localhost:3000')
  })

  it('requires HTTPS for external services', () => {
    expect(() =>
      createSetupConfig('external', {
        web: 'http://console.example.test',
        controlPlane: 'https://api.example.test',
        issuer: 'https://login.example.test/oidc'
      })
    ).toThrow('external URLs must use HTTPS')
  })

  it('keeps the external setup file to the Control Plane bootstrap locator by default', () => {
    expect(createSetupConfig('external', { controlPlane: 'https://api.example.test' })).toEqual({
      apiVersion: 'setup.agentconnect.md/v1alpha1',
      kind: 'AgentConnectSetup',
      mode: 'external',
      services: { controlPlane: 'https://api.example.test' }
    })
  })

  it.each([
    ['credentials', 'https://user:secret@console.example.test', 'URLs must not contain credentials'],
    ['query parameters', 'https://console.example.test?token=secret', 'URLs must not contain query parameters'],
    ['other protocols', 'ftp://console.example.test', 'URLs must use HTTP or HTTPS']
  ])('rejects %s in service URLs', (_label, web, message) => {
    expect(() =>
      createSetupConfig('external', {
        web,
        controlPlane: 'https://api.example.test',
        issuer: 'https://login.example.test/oidc'
      })
    ).toThrow(message)
  })

  it('writes a non-secret config once', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentconnect-setup-'))
    const path = join(directory, 'setup.yaml')
    const config = createSetupConfig('local')
    await writeSetupConfig(path, config)
    expect(await loadSetupConfig(path)).toEqual(config)
    expect(await readFile(path, 'utf8')).not.toMatch(/password|secret|token/i)
    await expect(writeSetupConfig(path, config)).rejects.toThrow('already exists')
  })

  it('rejects unknown config fields', () => {
    expect(() => SetupConfigSchema.parse({ ...createSetupConfig('local'), password: 'nope' })).toThrow()
  })
})

const response = (status: number, body?: unknown, url?: string): Response => {
  const result = new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' }
  })
  if (url) Object.defineProperty(result, 'url', { value: url })
  return result
}

const environmentRuntimeConfig = (): Response => response(200, { schemaVersion: '1', revision: null, config: null })

describe('deployment checks', () => {
  it('checks only the local services and no-auth mode', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/v1/runtime-config')) return environmentRuntimeConfig()
      if (url.endsWith('/api/v1/me')) return response(200)
      if (url === 'http://localhost:8080/readyz') return response(200, { status: 'ok' })
      if (url === 'http://localhost:8090/readyz') return response(200, { status: 'ready' })
      return response(200)
    })
    const findings = await checkDeployment(createSetupConfig('local'), { fetch: fetcher })
    expect(findings.every((finding) => finding.status === 'pass')).toBe(true)
    expect(findings.find((finding) => finding.id === 'control-plane.runtime-config')).toMatchObject({
      status: 'pass',
      message: expect.stringContaining('active deployment config revision: none')
    })
    expect(fetcher).toHaveBeenCalledTimes(5)
    expect(fetcher.mock.calls.some(([input]) => String(input).includes('openid-configuration'))).toBe(false)
  })

  it('verifies local Logto discovery, keys, enforced sign-in, and a trailing issuer slash', async () => {
    const issuer = 'http://login.agentconnect.localhost:3001/oidc'
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/v1/runtime-config')) return environmentRuntimeConfig()
      if (url.endsWith('/api/v1/me')) return response(401)
      if (url === 'http://localhost:8080/readyz') return response(200, { status: 'ok' })
      if (url === 'http://localhost:8090/readyz') return response(200, { status: 'ready' })
      if (url.endsWith('/.well-known/openid-configuration')) {
        return response(200, { issuer, jwks_uri: `${issuer}/jwks` })
      }
      if (url.endsWith('/oidc/jwks')) return response(200, { keys: [{ kid: 'one' }] })
      return response(200)
    })
    const config = SetupConfigSchema.parse({
      ...createSetupConfig('local-auth'),
      auth: { issuer: `${issuer}/` }
    })
    const findings = await checkDeployment(config, { fetch: fetcher })
    expect(findings.every((finding) => finding.status === 'pass')).toBe(true)
  })

  it('fails closed on an issuer mismatch', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/v1/runtime-config')) return environmentRuntimeConfig()
      if (url.endsWith('/api/v1/me')) return response(401)
      if (url === 'http://localhost:8080/readyz') return response(200, { status: 'ok' })
      if (url === 'http://localhost:8090/readyz') return response(200, { status: 'ready' })
      if (url.endsWith('/.well-known/openid-configuration')) {
        return response(200, {
          issuer: 'http://wrong.localhost:3001/oidc?token=sensitive',
          jwks_uri: 'http://wrong.localhost/jwks'
        })
      }
      return response(200)
    })
    const findings = await checkDeployment(createSetupConfig('local-auth'), { fetch: fetcher })
    const discovery = findings.find((finding) => finding.id === 'oidc.discovery')
    expect(discovery?.status).toBe('fail')
    expect(discovery?.message).not.toContain('sensitive')
    expect(reportExitCode(findings)).toBe(1)
  })

  it('reports a null discovery document as a structured failure', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/v1/runtime-config')) return environmentRuntimeConfig()
      if (url.endsWith('/api/v1/me')) return response(401)
      if (url === 'http://localhost:8080/readyz') return response(200, { status: 'ok' })
      if (url === 'http://localhost:8090/readyz') return response(200, { status: 'ready' })
      if (url.endsWith('/.well-known/openid-configuration')) return response(200, null)
      return response(200)
    })
    const findings = await checkDeployment(createSetupConfig('local-auth'), { fetch: fetcher })
    expect(findings.find((finding) => finding.id === 'oidc.discovery')).toMatchObject({
      status: 'fail',
      message: 'OIDC discovery returned an invalid document'
    })
  })

  it('does not accept redirected readiness endpoints', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/v1/runtime-config')) return environmentRuntimeConfig()
      if (url.endsWith('/readyz')) return response(302)
      return response(200)
    })
    const findings = await checkDeployment(createSetupConfig('local'), { fetch: fetcher })
    expect(findings.find((finding) => finding.id === 'control-plane.ready')?.status).toBe('fail')
    expect(findings.find((finding) => finding.id === 'relay.ready')?.status).toBe('fail')
  })

  it('rejects an HTTPS check that is redirected to HTTP', async () => {
    const config = createSetupConfig('external', {
      web: 'https://console.example.test',
      controlPlane: 'https://api.example.test',
      issuer: 'https://login.example.test/oidc'
    })
    if (config.mode !== 'external' || !config.services.web || !config.auth) {
      throw new Error('expected complete external config')
    }
    const issuer = config.auth.issuer
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/v1/runtime-config')) return environmentRuntimeConfig()
      if (url === config.services.web) return response(200, undefined, 'http://console.example.test')
      if (url.endsWith('/readyz')) return response(200, { status: 'ok' })
      if (url.endsWith('/api/v1/me')) return response(401)
      if (url.endsWith('/.well-known/openid-configuration')) {
        return response(200, { issuer, jwks_uri: `${issuer}/jwks` })
      }
      if (url.endsWith('/oidc/jwks')) return response(200, { keys: [{ kid: 'one' }] })
      return response(404)
    })
    const findings = await checkDeployment(config, { fetch: fetcher })
    expect(findings.find((finding) => finding.id === 'web.reachable')).toMatchObject({
      status: 'fail',
      message: expect.stringContaining('redirected to a non-HTTPS URL')
    })
  })

  it('uses the active database revision and auth instead of the setup profile', async () => {
    const endpoint = 'http://login.agentconnect.localhost:3001'
    const issuer = `${endpoint}/oidc`
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/v1/runtime-config')) {
        return response(200, {
          schemaVersion: '1',
          revision: 7,
          config: {
            apiUrl: 'http://localhost:8180/api/v1',
            relayUrl: 'http://localhost:8190',
            webUrl: 'http://localhost:3100',
            mcpUrl: null,
            auth: {
              endpoint,
              issuer,
              appId: 'agentconnect-web',
              apiResource: 'http://localhost:8080',
              socialProviders: ['github']
            }
          }
        })
      }
      if (url.endsWith('/api/v1/me')) return response(401)
      if (url === 'http://localhost:8180/readyz') return response(200, { status: 'ok' })
      if (url === 'http://localhost:8190/readyz') return response(200, { status: 'ready' })
      if (url.endsWith('/.well-known/openid-configuration')) {
        return response(200, { issuer, jwks_uri: `${issuer}/jwks` })
      }
      if (url.endsWith('/oidc/jwks')) return response(200, { keys: [{ kid: 'one' }] })
      return response(200)
    })

    const findings = await checkDeployment(createSetupConfig('local'), { fetch: fetcher })

    expect(findings.every((finding) => finding.status === 'pass')).toBe(true)
    expect(findings.find((finding) => finding.id === 'control-plane.runtime-config')).toEqual({
      id: 'control-plane.runtime-config',
      status: 'pass',
      message: 'AgentConnect API is running deployment config revision 7 with OIDC authentication'
    })
    expect(fetcher.mock.calls.some(([input]) => String(input) === `${issuer}/.well-known/openid-configuration`)).toBe(
      true
    )
    expect(fetcher.mock.calls.some(([input]) => String(input) === 'http://localhost:3100')).toBe(true)
    expect(fetcher.mock.calls.some(([input]) => String(input) === 'http://localhost:8080/readyz')).toBe(false)
    expect(fetcher.mock.calls.some(([input]) => String(input) === 'http://localhost:8090/readyz')).toBe(false)
  })

  it('renders stable JSON without response bodies', () => {
    const rendered = renderReport(
      'local',
      [{ id: 'web.reachable', status: 'pass', message: 'Web console is reachable' }],
      'json',
      '2026-08-05T00:00:00.000Z'
    )
    expect(JSON.parse(rendered)).toEqual({
      schemaVersion: '1',
      mode: 'local',
      checkedAt: '2026-08-05T00:00:00.000Z',
      findings: [{ id: 'web.reachable', status: 'pass', message: 'Web console is reachable' }],
      summary: { pass: 1, fail: 0 }
    })
  })

  it('uses distinct exit codes for failed and unknown readiness', () => {
    expect(reportExitCode([{ status: 'pass' }])).toBe(0)
    expect(reportExitCode([{ status: 'unknown' }])).toBe(2)
    expect(reportExitCode([{ status: 'unknown' }, { status: 'fail' }])).toBe(1)
  })
})
