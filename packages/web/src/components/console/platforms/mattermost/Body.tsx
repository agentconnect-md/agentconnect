// No 'use client' here: rendered only inside ModalProvider's tree (the client boundary).

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { PlatformMark } from '@/components/marks'
import { ApiError } from '@/lib/api'
import type { Agent } from '@/lib/data'
import type { WizardHost } from '../contract'
import { usePublishedFooter } from '../publish'

// The create route's own duplicate fence answers a racing install with a 409 that carries only this message.
const ALREADY_INSTALLED_MESSAGE = 'This Mattermost bot is already installed. Reuse the existing bot.'

type ErrorKey = 'invalidServerUrl' | 'invalidCredentials' | 'checkUnavailable' | 'alreadyInstalled'

function isLinkLocalOrUnspecifiedV4(ip: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (!match) return false
  const octets = match.slice(1).map(Number)
  if (octets.some((n) => n > 255)) return false
  const [a, b] = octets
  return a === 0 || (a === 169 && b === 254)
}

function mappedV4FromV6(lowered: string): string | null {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lowered)
  if (dotted?.[1]) return dotted[1]
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lowered)
  if (hex?.[1] && hex[2]) {
    const hi = parseInt(hex[1], 16)
    const lo = parseInt(hex[2], 16)
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
  }
  return null
}

function isLinkLocalOrUnspecifiedV6(host: string): boolean {
  const lowered = host.toLowerCase().split('%')[0] ?? ''
  if (lowered === '::' || /^0{1,4}(:0{1,4}){0,7}$/.test(lowered)) return true
  const mapped = mappedV4FromV6(lowered)
  if (mapped) return isLinkLocalOrUnspecifiedV4(mapped)
  const head = lowered.split(':')[0] ?? ''
  return /^fe[89ab][0-9a-f]$/.test(head)
}

function isCloudMattermostHost(host: string): boolean {
  const lowered = host.toLowerCase()
  return lowered === 'cloud.mattermost.com' || lowered.endsWith('.cloud.mattermost.com')
}

/** Checks that a pasted Mattermost server URL uses http(s), omits userinfo/query/fragment, and is not link-local/unspecified or cleartext Cloud. */
export function isValidMattermostServerUrl(raw: string): boolean {
  const trimmed = raw.trim()
  if (!trimmed || /[\s\u0000-\u001f\u007f]/.test(trimmed)) return false
  if (trimmed.includes('?') || trimmed.includes('#')) return false
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const authority = trimmed.slice(parsed.protocol.length + 2).split('/')[0] ?? ''
  if (parsed.username || parsed.password || authority.includes('@')) return false
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return false
  if (parsed.protocol === 'http:' && isCloudMattermostHost(host)) return false
  if (isLinkLocalOrUnspecifiedV4(host) || isLinkLocalOrUnspecifiedV6(host)) return false
  return true
}

/** Strips `/admin_console...` UI suffixes and trailing slashes while preserving any server subpath. */
export function normalizeMattermostServerUrl(raw: string): string {
  const parsed = new URL(raw.trim())
  const pathname = parsed.pathname.replace(/\/admin_console(?:\/.*)?$/i, '').replace(/\/+$/, '')
  return `${parsed.origin}${pathname === '' || pathname === '/' ? '' : pathname}`
}

const CLOUD_WORKSPACE_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i
const CLOUD_BARE_HOST_RE = /^(?:[a-z0-9-]+\.)*cloud\.mattermost\.com(?:[/:]|$)/i

/**
 * Resolves a Mattermost Cloud workspace slug (`acme` → `https://acme.cloud.mattermost.com`),
 * bare Cloud hostname (`acme.cloud.mattermost.com`), or explicit HTTPS URL; rejects plain `http://` in Cloud mode.
 */
export function resolveMattermostCloudUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (CLOUD_WORKSPACE_RE.test(trimmed)) return `https://${trimmed.toLowerCase()}.cloud.mattermost.com`
  const candidate =
    !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) && CLOUD_BARE_HOST_RE.test(trimmed) ? `https://${trimmed}` : trimmed
  if (!isValidMattermostServerUrl(candidate)) return null
  try {
    const parsed = new URL(candidate)
    if (parsed.protocol !== 'https:') return null
    return normalizeMattermostServerUrl(candidate)
  } catch {
    return null
  }
}

/** The localized sentence for a refusal the Console can explain better than the Control Plane's English. */
function errorKey(error: unknown): ErrorKey | null {
  if (!(error instanceof ApiError)) return null
  if (error.code === 'MATTERMOST_SERVER_URL_INVALID') return 'invalidServerUrl'
  if (error.code === 'MATTERMOST_CREDENTIALS_INVALID') return 'invalidCredentials'
  if (error.code === 'MATTERMOST_CHECK_UNAVAILABLE') return 'checkUnavailable'
  if (error.code === 'MATTERMOST_BOT_ALREADY_INSTALLED') return 'alreadyInstalled'
  if (error.status === 409 && error.message === ALREADY_INSTALLED_MESSAGE) return 'alreadyInstalled'
  return null
}

/** Mattermost's create pane: Self-hosted server URL or Mattermost Cloud workspace + Bot Account Token (or PAT). */
export function MattermostWizardBody({ agent, host }: { agent: Agent; host: WizardHost }) {
  const t = useTranslations('Platforms.mattermost')
  const [edition, setEdition] = useState<'selfHosted' | 'cloud'>('selfHosted')
  const [serverUrl, setServerUrl] = useState('')
  const [botToken, setBotToken] = useState('')
  const [saving, setSaving] = useState(false)
  const busy = useRef(false)
  const serverUrlTrim = serverUrl.trim()
  const resolvedUrl =
    edition === 'cloud'
      ? resolveMattermostCloudUrl(serverUrlTrim)
      : isValidMattermostServerUrl(serverUrlTrim)
        ? normalizeMattermostServerUrl(serverUrlTrim)
        : null
  const serverUrlOk = resolvedUrl !== null
  const botTokenTrim = botToken.trim()
  const valid = serverUrlOk && !!botTokenTrim
  const cloudSlugExpanded = edition === 'cloud' && resolvedUrl !== null && !serverUrlTrim.includes('://')

  function switchEdition(next: 'selfHosted' | 'cloud') {
    if (next === edition) return
    setEdition(next)
    host.setError(null)
  }

  async function submit() {
    if (!valid || !resolvedUrl || busy.current) return
    busy.current = true
    setSaving(true)
    host.setError(null)
    try {
      await host.createIntegration({
        platform: 'mattermost',
        agentId: agent.id,
        mattermost: {
          serverUrl: resolvedUrl,
          botToken: botTokenTrim
        }
      })
      host.close()
    } catch (error) {
      const key = errorKey(error)
      host.setError(key ? t(`errors.${key}`) : error instanceof Error ? error.message : String(error))
      busy.current = false
      setSaving(false)
    }
  }

  usePublishedFooter(host, {
    label: saving ? t('checking') : t('connect'),
    enabled: valid && !saving,
    onSubmit: () => void submit()
  })

  if (host.mode !== 'create') return null

  return (
    <div className="mb-4 rounded-[9px] border border-(--border-subtle) bg-(--surface-app) p-[14px]">
      <div
        role="tablist"
        aria-label={t('brand')}
        className="mb-3 inline-flex rounded-lg border border-(--border-default) bg-(--surface-card) p-[3px]"
      >
        {(['selfHosted', 'cloud'] as const).map((item) => {
          const active = edition === item
          return (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={active}
              disabled={saving}
              onClick={() => switchEdition(item)}
              className={`rounded-sm px-[11px] py-[5px] font-sans text-[12px] font-semibold leading-normal transition-colors focus-visible:shadow-(--focus-ring) focus-visible:outline-none ${
                active ? 'bg-(--brand-soft) text-(--brand)' : 'bg-transparent text-(--text-tertiary)'
              }`}
            >
              {t(`editions.${item}`)}
            </button>
          )
        })}
      </div>
      <div className="mb-3 flex gap-[10px]">
        <span className="mono mt-[1px] flex h-5 w-5 flex-none items-center justify-center rounded-full bg-(--surface-active) text-[11px] text-(--text-secondary)">
          1
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2 font-sans text-[12.5px] font-medium leading-[1.45] text-(--text-secondary)">
            <span className="imark mt-[1px] h-[18px] w-[18px] flex-none border-0 bg-transparent">
              <PlatformMark platform="mattermost" />
            </span>
            <span>{edition === 'cloud' ? t('cloud.step1') : t('step1')}</span>
          </div>
        </div>
      </div>
      <div className="mt-[14px] mb-[11px] flex items-center gap-[10px] border-t border-dashed border-(--border-default) pt-[13px]">
        <span className="mono flex h-5 w-5 flex-none items-center justify-center rounded-full bg-(--surface-active) text-[11px] text-(--text-secondary)">
          2
        </span>
        <span className="font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
          {edition === 'cloud' ? t('cloud.step2') : t('step2')}
        </span>
      </div>
      <form
        className="pl-[30px]"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <div className="grid grid-cols-1 gap-[10px] desktop:grid-cols-2">
          <label className="fld">
            <span className="fldlbl">{edition === 'cloud' ? t('cloud.workspaceOrUrl') : t('fields.serverUrl')}</span>
            <input
              className={`inp mn ${serverUrlTrim !== '' && !serverUrlOk ? 'border-(--status-error)' : ''}`}
              placeholder={
                edition === 'cloud' ? t('cloud.workspaceOrUrlPlaceholder') : t('fields.serverUrlPlaceholder')
              }
              value={serverUrl}
              onChange={(event) => setServerUrl(event.target.value)}
              disabled={saving}
            />
          </label>
          <label className="fld">
            <span className="fldlbl">{t('fields.botToken')}</span>
            <input
              className="inp mn"
              type="password"
              autoComplete="new-password"
              placeholder={t('fields.botTokenPlaceholder')}
              value={botToken}
              onChange={(event) => setBotToken(event.target.value)}
              disabled={saving}
            />
          </label>
        </div>
        {cloudSlugExpanded && (
          <p
            data-testid="mm-cloud-resolved"
            className="mt-1.5 mb-0 font-mono text-[11px] leading-normal text-(--text-secondary)"
          >
            → {resolvedUrl}
          </p>
        )}
        <p className="mt-2 mb-0 font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)">
          {edition === 'cloud' ? t('cloud.tokenHint') : t('tokenHint')}
        </p>
      </form>
    </div>
  )
}
