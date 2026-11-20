// No 'use client' here: rendered only inside ModalProvider's tree (the client boundary).

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import { Button, Icon } from '@/components/ui'
import { ApiError, type EmailAddressCheckDto, type EmailAddressNameReason } from '@/lib/api'
import type { Agent } from '@/lib/data'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'
import type { WizardHost } from '../contract'
import { usePublishedFooter, usePublishedIdentityChrome } from '../publish'
import { emailApi } from './api'
import { AddressField } from './fields'

/** How long typing pauses before the name is checked. */
export const EMAIL_NAME_CHECK_DELAY_MS = 300

/** The create refusals the Console words itself, by the reason they share with the live check. */
const REFUSAL_REASON: Readonly<Record<string, EmailAddressNameReason>> = {
  EMAIL_NOT_CONFIGURED: 'not_configured',
  EMAIL_NAME_LENGTH: 'length',
  EMAIL_NAME_CHARACTERS: 'characters',
  EMAIL_NAME_RESERVED: 'reserved',
  EMAIL_ADDRESS_TAKEN: 'taken'
}

const SWR_OPTIONS = { revalidateOnFocus: false, shouldRetryOnError: false } as const

/** The name's availability once typing pauses; `current` is false while the answer is for an older name. */
function useNameCheck(name: string, mockMode: boolean) {
  // Design mode may have no organization, and answers without one.
  const orgId = useOrgs().activeOrg?.id ?? (mockMode ? 'mock' : undefined)
  const [settled, setSettled] = useState(name)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(name), EMAIL_NAME_CHECK_DELAY_MS)
    return () => clearTimeout(timer)
  }, [name])
  const fetcher = ([, orgId, , named]: readonly [string, string, string, string]) =>
    emailApi.check(orgId, named || undefined, mockMode)
  const domain = useSWR<EmailAddressCheckDto>(consoleKeys.emailAddress(orgId, ''), fetcher, SWR_OPTIONS)
  const check = useSWR<EmailAddressCheckDto>(
    settled ? consoleKeys.emailAddress(orgId, settled) : null,
    fetcher,
    SWR_OPTIONS
  )
  const current = settled === name && !check.isLoading
  return {
    mailDomain: domain.data?.mailDomain ?? check.data?.mailDomain ?? null,
    answer: current ? (check.data ?? null) : null,
    failed: current && check.error !== undefined
  }
}

/** Email's create pane: one name beside the mail domain, checked as it is typed, then the address to copy. */
export function EmailWizardBody({ agent, host }: { agent: Agent; host: WizardHost }) {
  const t = useTranslations('Platforms.email')
  const [input, setInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [created, setCreated] = useState<string | null>(null)
  const busy = useRef(false)
  const name = input.trim().toLowerCase()
  const { mailDomain, answer, failed } = useNameCheck(name, host.mockMode)
  const address = answer?.available ? answer.address : null

  async function submit() {
    if (!address || busy.current) return
    busy.current = true
    setSaving(true)
    host.setError(null)
    try {
      await host.createIntegration({ platform: 'email', agentId: agent.id, transport: 'http', email: { name } })
      setCreated(address)
    } catch (error) {
      const reason = error instanceof ApiError && error.code ? REFUSAL_REASON[error.code] : undefined
      host.setError(reason ? t(`reason.${reason}`) : error instanceof Error ? error.message : String(error))
    } finally {
      busy.current = false
      setSaving(false)
    }
  }

  // An address is never moved to another agent, so there is no identity to choose; hiding that chrome hides the footer's primary too, so the pane commits inline.
  usePublishedIdentityChrome(host, { hidden: true })
  usePublishedFooter(host, { label: t('create'), enabled: false, onSubmit: () => undefined, hidden: true })

  if (created) {
    return (
      <div className="mb-4 flex flex-col gap-2">
        <AddressField address={created} />
        <p role="status" className="m-0 font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-tertiary)">
          {t('created')}
        </p>
        <div className="flex justify-end">
          <Button onClick={host.close}>{t('done')}</Button>
        </div>
      </div>
    )
  }

  const status = !name
    ? null
    : failed
      ? { ok: false, text: t('checkFailed') }
      : !answer
        ? { ok: null, text: t('checking') }
        : answer.available
          ? { ok: true, text: t('available', { address: answer.address ?? '' }) }
          : { ok: false, text: t(`reason.${answer.reason ?? 'taken'}`) }
  return (
    <div className="mb-4 flex flex-col gap-2">
      <label className="fld">
        <span className="fldlbl">{t('address')}</span>
        <span className="flex min-w-0 items-center gap-2">
          <input
            className={`inp mn min-w-0 flex-1 ${status?.ok === false ? 'border-(--status-error)' : ''}`}
            value={input}
            placeholder={t('placeholder')}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={64}
            disabled={saving}
            aria-invalid={status?.ok === false}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submit()
            }}
          />
          <span className="mono min-w-0 flex-none break-all text-[13px] text-(--text-secondary)">
            @{mailDomain ?? '…'}
          </span>
        </span>
      </label>
      {status && (
        <p
          role="status"
          className={`m-0 flex items-start gap-[6px] font-sans text-[12.5px] font-normal leading-[1.5] ${
            status.ok === true
              ? 'text-(--status-online)'
              : status.ok === false
                ? 'text-(--status-error)'
                : 'text-(--text-tertiary)'
          }`}
        >
          {status.ok !== null && (
            <Icon name={status.ok ? 'check' : 'triangle-exclamation-point'} size={14} className="mt-[2px] flex-none" />
          )}
          <span className="min-w-0 break-all">{status.text}</span>
        </p>
      )}
      <div className="flex justify-end">
        <Button disabled={!address || saving} onClick={() => void submit()}>
          <Icon name="plus" size={15} />
          {saving ? t('creating') : t('create')}
        </Button>
      </div>
    </div>
  )
}
