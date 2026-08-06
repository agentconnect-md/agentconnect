import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { githubRequest, mintAppJwt, resolveGithubSetupAppConfig } from '@agentconnect.md/control-plane/github-app-api'
import type { ProviderAppConfig } from './provider-app.js'

export interface GithubAppCredentials {
  appId: string
  slug: string
  clientId: string
  clientSecret: string
  privateKeyBase64: string
  webhookSecret?: string
}

export interface GithubManifestFlow {
  startUrl: string
  code: Promise<string>
  close(): Promise<void>
}

export interface GithubManifestFlowOptions {
  timeoutMs?: number
}

export interface GithubConversionOptions {
  fetch?: typeof fetch
  timeoutMs?: number
}

export interface GithubLoginAppConfig {
  webUrl: string
  logtoEndpoint: string
  connectorId: string
}

export const GITHUB_APP_PERMISSIONS = {
  metadata: 'read',
  contents: 'write',
  issues: 'write',
  pull_requests: 'write',
  actions: 'write',
  checks: 'write',
  workflows: 'write',
  emails: 'read'
} as const

export const GITHUB_APP_EVENTS = [
  'push',
  'issues',
  'issue_comment',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'check_run',
  'check_suite',
  'release',
  'repository'
] as const

const GITHUB_ORG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/

function appendPath(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

export function githubManifestRegistrationUrl(githubOrg: string | undefined, state: string): string {
  if (githubOrg !== undefined && !GITHUB_ORG.test(githubOrg)) {
    throw new Error('GitHub organization login is invalid')
  }
  const base = githubOrg
    ? `https://github.com/organizations/${githubOrg}/settings/apps/new`
    : 'https://github.com/settings/apps/new'
  const url = new URL(base)
  url.searchParams.set('state', state)
  return url.toString()
}

export function buildGithubAppManifest(
  config: ProviderAppConfig,
  name: string,
  redirectUrl: string,
  login?: GithubLoginAppConfig
): Record<string, unknown> {
  const webUrl = githubServiceUrl(config.services.web, 'Web')
  const controlPlaneUrl = githubServiceUrl(config.services.controlPlane, 'API')
  const relayUrl = githubServiceUrl(config.services.relay, 'ingress')
  const webhookActive = new URL(relayUrl).protocol === 'https:'
  return {
    name: name.trim() || 'AgentConnect',
    url: webUrl,
    redirect_url: redirectUrl,
    ...(login
      ? {
          callback_urls: [
            appendPath(login.logtoEndpoint, `/callback/${login.connectorId}`),
            appendPath(login.logtoEndpoint, `/account/callback/social/${login.connectorId}`),
            appendPath(login.webUrl, '/auth/social/callback')
          ]
        }
      : {}),
    setup_url: appendPath(controlPlaneUrl, '/v1/github/setup/callback'),
    setup_on_update: true,
    public: true,
    request_oauth_on_install: false,
    ...(webhookActive
      ? {
          hook_attributes: {
            url: appendPath(relayUrl, '/webhooks/github'),
            active: true
          },
          default_events: [...GITHUB_APP_EVENTS]
        }
      : {}),
    default_permissions: GITHUB_APP_PERMISSIONS
  }
}

export interface GithubConfiguredUrls {
  externalUrl: string
  setupUrl: string
  webhookUrl: string
  webhookActive: boolean
  callbackUrls: string[]
}

function githubServiceUrl(value: string | undefined, label: string): string {
  if (!value) throw new Error(`GitHub App creation requires a saved ${label} URL`)
  const url = new URL(value)
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`GitHub App ${label} URL must use HTTPS unless it is loopback`)
  }
  return url.origin
}

export function githubConfiguredUrls(
  config: ProviderAppConfig,
  manifest: Record<string, unknown>
): GithubConfiguredUrls {
  if (typeof manifest.url !== 'string' || typeof manifest.setup_url !== 'string') {
    throw new Error('GitHub App manifest is missing managed URLs')
  }
  const relayUrl = githubServiceUrl(config.services.relay, 'ingress')
  return {
    externalUrl: manifest.url,
    setupUrl: manifest.setup_url,
    webhookUrl: appendPath(relayUrl, '/webhooks/github'),
    webhookActive: new URL(relayUrl).protocol === 'https:',
    callbackUrls: Array.isArray(manifest.callback_urls)
      ? manifest.callback_urls.filter((value): value is string => typeof value === 'string')
      : []
  }
}

interface GithubAppApiResponse {
  id?: unknown
  slug?: unknown
  client_id?: unknown
  external_url?: unknown
  html_url?: unknown
  permissions?: unknown
  events?: unknown
  owner?: unknown
}

interface GithubWebhookApiResponse {
  url?: unknown
}

export interface GithubAppAuditResult {
  app: { id: number; slug: string; owner: string | null; settingsUrl: string }
  missing: string[]
  diff: Array<{ id: string; field: string; current: unknown; expected: unknown }>
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function sameRecord(left: unknown, right: Record<string, string>): boolean {
  const actual = asRecord(left)
  const actualKeys = Object.keys(actual).sort()
  const expectedKeys = Object.keys(right).sort()
  return (
    JSON.stringify(actualKeys) === JSON.stringify(expectedKeys) &&
    expectedKeys.every((key) => actual[key] === right[key])
  )
}

function sameStringSet(left: unknown, right: readonly string[]): boolean {
  if (!Array.isArray(left) || !left.every((value) => typeof value === 'string')) return false
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
}

export async function auditGithubApp(
  identity: { appId: number; slug: string; clientId: string | null },
  privateKeyBase64: string,
  expectedManifest: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch
): Promise<GithubAppAuditResult> {
  const config = resolveGithubSetupAppConfig({ ...identity, privateKeyBase64 })
  const jwt = await mintAppJwt(config)
  const expectedHook = asRecord(expectedManifest.hook_attributes)
  const [app, hook] = await Promise.all([
    githubRequest<GithubAppApiResponse>('/app', { auth: jwt, fetchImpl }),
    typeof expectedHook.url === 'string'
      ? githubRequest<GithubWebhookApiResponse>('/app/hook/config', { auth: jwt, fetchImpl })
      : Promise.resolve(undefined)
  ])
  const diff: GithubAppAuditResult['diff'] = []
  const addDiff = (id: string, field: string, current: unknown, expected: unknown) => {
    diff.push({ id, field, current, expected })
  }
  const currentIdentity = { appId: app.id, slug: app.slug, clientId: app.client_id ?? null }
  const expectedIdentity = { appId: identity.appId, slug: identity.slug, clientId: identity.clientId }
  if (
    app.id !== identity.appId ||
    app.slug !== identity.slug ||
    (identity.clientId !== null && app.client_id !== identity.clientId)
  ) {
    addDiff('identity', 'App identity', currentIdentity, expectedIdentity)
  }
  if (app.external_url !== expectedManifest.url) {
    addDiff('external_url', 'Homepage URL', app.external_url ?? null, expectedManifest.url ?? null)
  }
  const expectedPermissions = GITHUB_APP_PERMISSIONS
  if (!sameRecord(app.permissions, expectedPermissions)) {
    addDiff('permissions', 'Repository permissions', asRecord(app.permissions), expectedPermissions)
  }
  const expectedEvents = Array.isArray(expectedManifest.default_events)
    ? expectedManifest.default_events.filter((event): event is string => typeof event === 'string')
    : []
  if (!sameStringSet(app.events, expectedEvents)) {
    addDiff('events', 'Webhook events', Array.isArray(app.events) ? app.events : [], expectedEvents)
  }
  if (typeof expectedHook.url === 'string' && hook?.url !== expectedHook.url) {
    addDiff('webhook_url', 'Webhook URL', hook?.url ?? null, expectedHook.url)
  }

  const owner = asRecord(app.owner)
  const ownerLogin = typeof owner.login === 'string' ? owner.login : null
  const ownerType = owner.type
  const settingsUrl =
    ownerType === 'Organization' && ownerLogin
      ? `https://github.com/organizations/${encodeURIComponent(ownerLogin)}/settings/apps/${encodeURIComponent(identity.slug)}`
      : `https://github.com/settings/apps/${encodeURIComponent(identity.slug)}`
  return {
    app: { id: identity.appId, slug: identity.slug, owner: ownerLogin, settingsUrl },
    missing: [...new Set(diff.map((item) => item.id))],
    diff
  }
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

async function startGithubManifestRegistration(
  buildManifest: (redirectUrl: string) => Record<string, unknown>,
  githubOrg?: string,
  options: GithubManifestFlowOptions = {}
): Promise<GithubManifestFlow> {
  const state = randomBytes(32).toString('base64url')
  const startToken = randomBytes(24).toString('base64url')
  const scriptNonce = randomBytes(18).toString('base64url')
  const action = githubManifestRegistrationUrl(githubOrg, state)
  let settle: ((value: string) => void) | undefined
  let rejectCode: ((reason: Error) => void) | undefined
  let settled = false
  const code = new Promise<string>((resolve, reject) => {
    settle = resolve
    rejectCode = reject
  })

  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
    response.setHeader('cache-control', 'no-store')
    response.setHeader('x-content-type-options', 'nosniff')

    if (request.method === 'GET' && requestUrl.pathname === `/start/${startToken}`) {
      const address = server.address() as AddressInfo
      const redirectUrl = `http://127.0.0.1:${address.port}/callback`
      const manifest = buildManifest(redirectUrl)
      const body = `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Create AgentConnect GitHub App</title>
<body><p>Continuing to GitHub…</p>
<form id="manifest-form" method="post" action="${escapeHtml(action)}">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<button type="submit">Continue to GitHub</button></form>
<script nonce="${scriptNonce}">document.getElementById('manifest-form').submit()</script></body></html>`
      response.statusCode = 200
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.setHeader(
        'content-security-policy',
        `default-src 'none'; form-action https://github.com; script-src 'nonce-${scriptNonce}'; style-src 'none'; base-uri 'none'`
      )
      response.end(body)
      return
    }

    if (request.method === 'GET' && requestUrl.pathname === '/callback') {
      const returnedState = requestUrl.searchParams.get('state') ?? ''
      const returnedCode = requestUrl.searchParams.get('code') ?? ''
      const providerError = requestUrl.searchParams.get('error')
      if (!safeEqual(returnedState, state)) {
        response.statusCode = 400
        response.end('Invalid state. Return to the terminal and try again.')
        return
      }
      if (providerError || !returnedCode) {
        response.statusCode = 400
        response.end('GitHub App creation was not completed. Return to the terminal.')
        if (!settled) {
          settled = true
          rejectCode?.(new Error('GitHub App creation was cancelled or denied'))
        }
        return
      }

      response.statusCode = 200
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end(
        '<!doctype html><meta charset="utf-8"><title>AgentConnect</title><p>GitHub App created. Return to the terminal.</p>'
      )
      if (!settled) {
        settled = true
        settle?.(returnedCode)
      }
      return
    }

    response.statusCode = 404
    response.end('Not found')
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address() as AddressInfo
  const timeout = setTimeout(
    () => {
      if (!settled) {
        settled = true
        rejectCode?.(new Error('timed out waiting for GitHub App creation'))
      }
      void closeServer(server)
    },
    options.timeoutMs ?? 15 * 60_000
  )
  timeout.unref()
  void code.then(
    () => clearTimeout(timeout),
    () => clearTimeout(timeout)
  )

  return {
    startUrl: `http://127.0.0.1:${address.port}/start/${startToken}`,
    code,
    async close() {
      clearTimeout(timeout)
      await closeServer(server)
    }
  }
}

export function startGithubManifestFlow(
  config: ProviderAppConfig,
  name: string,
  githubOrg?: string,
  options: GithubManifestFlowOptions = {},
  login?: GithubLoginAppConfig
): Promise<GithubManifestFlow> {
  return startGithubManifestRegistration(
    (redirectUrl) => buildGithubAppManifest(config, name, redirectUrl, login),
    githubOrg,
    options
  )
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`GitHub manifest conversion response is missing ${field}`)
  }
  return value
}

function requiredAppId(record: Record<string, unknown>): string {
  if (typeof record.id !== 'number' || !Number.isSafeInteger(record.id) || record.id <= 0) {
    throw new Error('GitHub manifest conversion response is missing a valid id')
  }
  return String(record.id)
}

async function exchangeGithubManifest(
  code: string,
  options: GithubConversionOptions = {}
): Promise<Record<string, unknown>> {
  const fetcher = options.fetch ?? fetch
  let response: Response
  try {
    response = await fetcher(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': '@agentconnect.md/setup'
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000)
    })
  } catch {
    throw new Error('GitHub manifest conversion is unreachable')
  }
  if (!response.ok) throw new Error(`GitHub manifest conversion returned HTTP ${response.status}`)

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error('GitHub manifest conversion returned an invalid response')
  }
  return asRecord(body)
}

export async function convertGithubManifest(
  code: string,
  options: GithubConversionOptions = {}
): Promise<GithubAppCredentials> {
  const record = await exchangeGithubManifest(code, options)
  const appId = requiredAppId(record)
  const pem = requiredString(record, 'pem')
  const clientId = requiredString(record, 'client_id')
  const privateKeyBase64 = Buffer.from(pem, 'utf8').toString('base64')
  const webhookSecret =
    typeof record.webhook_secret === 'string' && record.webhook_secret ? record.webhook_secret : undefined
  return {
    appId,
    slug: requiredString(record, 'slug'),
    clientId,
    clientSecret: requiredString(record, 'client_secret'),
    privateKeyBase64,
    ...(webhookSecret ? { webhookSecret } : {})
  }
}
