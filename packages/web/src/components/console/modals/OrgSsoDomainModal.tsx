// No 'use client' here: rendered only inside OrganizationSsoCard (a client component).

import { useId, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button, Icon } from '@/components/ui'
import { Scrim } from '@/components/console/Scrim'
import { addOrgSsoDomain, ApiError } from '@/lib/api'

// A hostname with at least one dot; the Control Plane has the final say.
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/** Add a domain to claim for single sign-on; the card then shows the DNS record that proves it. */
export default function OrgSsoDomainModal({
  orgId,
  onClose,
  onAdded
}: {
  orgId: string
  onClose: () => void
  onAdded: () => void
}) {
  const t = useTranslations('Settings.sso.addDomain')
  const tc = useTranslations('Common.actions')
  const titleId = useId()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const domain = value.trim().toLowerCase()

  const submit = async () => {
    if (busy) return
    if (!DOMAIN_RE.test(domain)) {
      setError(t('invalid'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      await addOrgSsoDomain(domain, orgId)
      onAdded()
      onClose()
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === 'SSO_DOMAIN_TAKEN'
          ? t('taken')
          : e instanceof ApiError && e.code === 'SSO_DOMAIN_LIMIT'
            ? t('limit')
            : e instanceof ApiError && e.status === 400
              ? t('invalid')
              : e instanceof Error
                ? e.message
                : String(e)
      )
      setBusy(false)
    }
  }

  return (
    <Scrim onEscape={busy ? undefined : onClose}>
      <form
        className="modal max-w-[460px]"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <div className="modalhead">
          <span id={titleId} className="flex-1 font-sans text-[16px] font-semibold leading-normal">
            {t('title')}
          </span>
          <button type="button" className="iconbtn" aria-label={tc('close')} disabled={busy} onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modalbody">
          <label className="fld">
            <span className="fldlbl">{t('domain')}</span>
            <div className={error ? 'inp mn border-(--status-error)' : 'inp mn'}>
              <input
                autoFocus
                className="min-w-0 flex-1 border-0 bg-transparent font-[inherit] text-[12.5px] outline-none placeholder:text-(--text-disabled)"
                value={value}
                placeholder="acme.example"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={error ? true : undefined}
                onChange={(event) => {
                  setValue(event.target.value)
                  setError(null)
                }}
              />
            </div>
          </label>
          {error && (
            <div
              className="mt-2 flex items-center gap-[6px] font-sans text-[12.5px] font-medium leading-normal text-(--status-error)"
              role="alert"
            >
              <Icon name="circle-exclamation-point" size={14} className="flex-none" />
              {error}
            </div>
          )}
        </div>
        <div className="modalfoot">
          <div className="flex-1" />
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {tc('cancel')}
          </Button>
          <Button type="submit" disabled={busy || !domain}>
            {t('submit')}
          </Button>
        </div>
      </form>
    </Scrim>
  )
}
