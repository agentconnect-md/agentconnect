import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { SetupConfig } from './config.js'
import { requireExternalRelay } from './slack-app.js'

export const GITHUB_DEPLOYMENT_ENV_KEYS = [
  'GITHUB_APP_ID',
  'GITHUB_APP_SLUG',
  'GITHUB_APP_CLIENT_ID',
  'GITHUB_APP_PRIVATE_KEY_B64',
  'GITHUB_APP_WEBHOOK_SECRET',
  'GITHUB_APP_CLIENT_SECRET'
] as const

export interface GithubAppCredentials {
  appId: string
  slug: string
  clientId: string
  clientSecret: string
  privateKeyBase64: string
  webhookSecret: string
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

function registrationUrl(githubOrg: string | undefined, state: string): string {
  if (githubOrg !== undefined && !GITHUB_ORG.test(githubOrg)) {
    throw new Error('--github-org must be a GitHub organization login')
  }
  const base = githubOrg
    ? `https://github.com/organizations/${githubOrg}/settings/apps/new`
    : 'https://github.com/settings/apps/new'
  const url = new URL(base)
  url.searchParams.set('state', state)
  return url.toString()
}

export function buildGithubAppManifest(
  config: SetupConfig,
  name: string,
  redirectUrl: string
): Record<string, unknown> {
  requireExternalRelay(config)
  return {
    name: name.trim() || 'AgentConnect',
    url: config.services.web,
    redirect_url: redirectUrl,
    setup_url: appendPath(config.services.controlPlane, '/v1/github/setup/callback'),
    setup_on_update: true,
    public: true,
    request_oauth_on_install: false,
    hook_attributes: {
      url: appendPath(config.services.relay, '/webhooks/github'),
      active: true
    },
    default_permissions: {
      metadata: 'read',
      contents: 'write',
      issues: 'write',
      pull_requests: 'write',
      actions: 'write',
      checks: 'write',
      workflows: 'write'
    },
    default_events: [
      'push',
      'issues',
      'issue_comment',
      'pull_request',
      'pull_request_review_comment',
      'check_run',
      'check_suite'
    ]
  }
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

export async function startGithubManifestFlow(
  config: SetupConfig,
  name: string,
  githubOrg?: string,
  options: GithubManifestFlowOptions = {}
): Promise<GithubManifestFlow> {
  requireExternalRelay(config)
  const state = randomBytes(32).toString('base64url')
  const startToken = randomBytes(24).toString('base64url')
  const scriptNonce = randomBytes(18).toString('base64url')
  const action = registrationUrl(githubOrg, state)
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
      const manifest = buildGithubAppManifest(config, name, redirectUrl)
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

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('GitHub manifest conversion returned incomplete credentials')
  }
  return value
}

export async function convertGithubManifest(
  code: string,
  options: GithubConversionOptions = {}
): Promise<GithubAppCredentials> {
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
  const record = asRecord(body)
  if (typeof record.id !== 'number' || !Number.isSafeInteger(record.id) || record.id <= 0) {
    throw new Error('GitHub manifest conversion returned incomplete credentials')
  }
  const pem = requiredString(record, 'pem')
  return {
    appId: String(record.id),
    slug: requiredString(record, 'slug'),
    clientId: requiredString(record, 'client_id'),
    clientSecret: requiredString(record, 'client_secret'),
    privateKeyBase64: Buffer.from(pem, 'utf8').toString('base64'),
    webhookSecret: requiredString(record, 'webhook_secret')
  }
}
