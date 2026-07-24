'use client'

import { useEffect, useState } from 'react'
import { isAuthConfigured, getUser, login } from '@/lib/auth'
import { getOAuthConsentContext, postOAuthConsent, type OAuthConsentContext } from '@/lib/api'
import { Spinner } from '@/components/marks'

// The OAuth consent screen (agent-assistant.md §7.3). The CP's /oauth/authorize
// bounces a remote MCP client's browser here; this page authenticates the human
// (Logto — the CP holds no browser session), shows what the client is asking for,
// lets the user pick which org to grant, and posts the decision back to the CP,
// which mints the authorization code and returns the URL to bounce back to the client.

interface AuthzParams {
  clientId: string
  redirectUri: string
  codeChallenge: string
  codeChallengeMethod: string
  scope?: string
  state?: string
  resource?: string
}

const SCOPE_LABEL: Record<string, string> = {
  'mcp:read': 'View your agents, daemons, schedules, sessions, and usage',
  'mcp:write': 'Create and modify your agents, schedules, and integrations'
}

export default function OAuthConsentPage() {
  const [params, setParams] = useState<AuthzParams | null>(null)
  const [ctx, setCtx] = useState<OAuthConsentContext | null>(null)
  const [orgId, setOrgId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState<null | 'allow' | 'deny'>(null)

  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    const clientId = q.get('client_id') ?? ''
    const redirectUri = q.get('redirect_uri') ?? ''
    if (!clientId || !redirectUri) {
      setError('Invalid authorization request — missing client or redirect.')
      return
    }
    const p: AuthzParams = {
      clientId,
      redirectUri,
      codeChallenge: q.get('code_challenge') ?? '',
      codeChallengeMethod: q.get('code_challenge_method') ?? '',
      ...(q.get('scope') ? { scope: q.get('scope')! } : {}),
      ...(q.get('state') ? { state: q.get('state')! } : {}),
      ...(q.get('resource') ? { resource: q.get('resource')! } : {})
    }
    setParams(p)
    void (async () => {
      // When auth is enabled, ensure the user is signed in first — stashing this URL
      // so /auth/callback returns here. With auth disabled the CP's devAuth admits us.
      if (isAuthConfigured() && !(await getUser())) {
        try {
          sessionStorage.setItem('ac.returnTo', window.location.pathname + window.location.search)
        } catch {
          /* ignore */
        }
        await login()
        return
      }
      try {
        const c = await getOAuthConsentContext(clientId, p.scope)
        setCtx(c)
        setOrgId(c.organizations[0]?.id ?? '')
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load the authorization request.')
      }
    })()
  }, [])

  async function decide(decision: 'allow' | 'deny') {
    if (!params) return
    if (decision === 'allow' && !orgId) {
      setError('Select an organization to continue.')
      return
    }
    setSubmitting(decision)
    setError(null)
    try {
      const { redirectUrl } = await postOAuthConsent({ ...params, orgId, decision })
      window.location.href = redirectUrl
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.')
      setSubmitting(null)
    }
  }

  const appName = ctx?.clientName || 'An application'

  return (
    <div className="authpage">
      <div className="m-auto flex w-full max-w-[420px] flex-col gap-[20px] rounded-[14px] border border-(--border-default) bg-(--surface-card) p-[28px] font-sans">
        {error && !ctx && !params ? (
          <p className="text-[14px] leading-normal text-(--red-600)">{error}</p>
        ) : !ctx ? (
          <div className="flex flex-col items-center gap-[16px] py-[24px] text-[14px] text-(--text-secondary)">
            <Spinner size={40} />
            Preparing authorization…
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-[6px]">
              <h1 className="text-[18px] font-semibold leading-tight text-(--text-primary)">Authorize {appName}</h1>
              <p className="text-[13px] leading-normal text-(--text-secondary)">
                {appName} wants to access AgentConnect on your behalf. It will act with your permissions in the
                organization you choose.
              </p>
            </div>

            <div className="flex flex-col gap-[8px]">
              <span className="text-[12px] font-medium uppercase tracking-wide text-(--text-tertiary)">
                It will be able to
              </span>
              <ul className="flex flex-col gap-[6px]">
                {ctx.scopes.map((s) => (
                  <li key={s} className="text-[13px] leading-normal text-(--text-primary)">
                    • {SCOPE_LABEL[s] ?? s}
                  </li>
                ))}
              </ul>
            </div>

            <label className="flex flex-col gap-[6px]">
              <span className="text-[12px] font-medium uppercase tracking-wide text-(--text-tertiary)">
                Organization
              </span>
              <select
                value={orgId}
                onChange={(e) => setOrgId(e.target.value)}
                disabled={submitting !== null}
                className="rounded-[8px] border border-(--border-default) bg-(--surface-card) px-[10px] py-[8px] text-[14px] text-(--text-primary)"
              >
                {ctx.organizations.length === 0 && <option value="">No organizations</option>}
                {ctx.organizations.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name || o.slug} ({o.role})
                  </option>
                ))}
              </select>
            </label>

            {error && <p className="text-[13px] leading-normal text-(--red-600)">{error}</p>}

            <div className="flex gap-[10px]">
              <button
                type="button"
                onClick={() => decide('deny')}
                disabled={submitting !== null}
                className="flex-1 rounded-[8px] border border-(--border-default) px-[14px] py-[9px] text-[14px] font-medium text-(--text-primary) disabled:opacity-50"
              >
                Deny
              </button>
              <button
                type="button"
                onClick={() => decide('allow')}
                disabled={submitting !== null || ctx.organizations.length === 0}
                className="flex-1 rounded-[8px] bg-(--brand) px-[14px] py-[9px] text-[14px] font-medium text-white disabled:opacity-50"
              >
                {submitting === 'allow' ? 'Authorizing…' : 'Authorize'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
