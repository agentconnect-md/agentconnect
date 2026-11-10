'use client'

// A Fill card (computer-form-fill-and-vault.md §6): a person types a website form's values here; the agent never sees them.
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import type { ComputerFormValue } from '@agentconnect.md/protocol/computer-form-fill'
import type { FillCardAnswer, FillCardBody } from '@/lib/data'
import { Icon } from '@/components/ui'

const INPUT = 'inp w-full min-w-0 bg-(--surface-app) disabled:cursor-default disabled:opacity-55 desktop:max-w-[360px]'
const HINT = 'font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)'
const INPUT_TYPES: Record<string, string> = {
  email: 'email',
  tel: 'tel',
  number: 'number',
  url: 'url',
  date: 'date',
  search: 'text',
  text: 'text'
}

type Field = FillCardBody['fields'][number]

const OUTCOME_KEYS = {
  sending: 'outcome.sending',
  filled: 'outcome.filled',
  partial: 'outcome.partial',
  failed: 'outcome.failed',
  uncertain: 'outcome.uncertain',
  target_changed: 'outcome.target_changed',
  unsupported: 'outcome.unsupported',
  cancelled: 'outcome.cancelled',
  expired: 'outcome.expired'
} as const

const fieldLabel = (field: Field): string => field.label || field.placeholder || field.name || field.purpose

export function FillCard({
  body,
  onAnswer,
  now = Date.now
}: {
  body: FillCardBody
  /** Absent ⇒ this reader cannot answer from here, and the card is a record. */
  onAnswer?: (answer: FillCardAnswer) => Promise<{ accepted: boolean; reason?: string }>
  now?: () => number
}) {
  const t = useTranslations('FillCard')
  // Values live only in this component's state until sent; nothing writes them anywhere else.
  const [values, setValues] = useState<Record<string, string>>({})
  const [checks, setChecks] = useState<Record<string, boolean>>({})
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState<'filled' | 'cancelled' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const expired = Date.parse(body.expiresAt) <= now()
  const settled = body.resolved ?? (sent === 'cancelled' ? 'cancelled' : expired ? 'expired' : null)

  const answer = async (next: FillCardAnswer) => {
    if (!onAnswer || sending) return
    setSending(true)
    setError(null)
    try {
      const result = await onAnswer(next)
      if (!result.accepted) {
        setError(result.reason ?? t('notAccepted'))
        return
      }
      // Sent: the values leave this page's state at once, whatever the fill's outcome.
      setValues({})
      setChecks({})
      setSent('cancel' in next ? 'cancelled' : 'filled')
    } catch (err) {
      setError(err instanceof Error ? err.message : t('notAccepted'))
    } finally {
      setSending(false)
    }
  }

  const submit = () => {
    const filled = body.fields.flatMap((field): ComputerFormValue[] =>
      field.control === 'checkbox'
        ? field.id in checks
          ? [{ field: field.id, checked: checks[field.id]! }]
          : []
        : values[field.id]
          ? [{ field: field.id, value: values[field.id]! }]
          : []
    )
    if (filled.length) void answer({ values: filled })
  }

  const unmaskedSecret = body.fields.some((field) => field.secret && field.control !== 'password')
  const live = !settled && !sent && !!onAnswer

  return (
    <div data-fill-card={body.requestId} className="card flex max-w-[560px] flex-col gap-[10px] p-3">
      <div className="flex items-center gap-2 font-sans text-[12px] font-semibold uppercase leading-normal tracking-[0.04em] text-(--text-tertiary)">
        <Icon name="key-round" size={13} />
        <span>{t('crumb', { computer: body.computerName })}</span>
      </div>
      {/* The website as the browser reports it: the one thing a person decides by. */}
      <div className="flex min-w-0 flex-col gap-[2px]">
        <span className="truncate font-mono text-[13.5px] font-semibold leading-normal text-(--text-primary)">
          {body.website.origin}
        </span>
        {body.website.title ? <span className={`truncate ${HINT}`}>{body.website.title}</span> : null}
        {body.frameOrigin ? <span className={HINT}>{t('frame', { origin: body.frameOrigin })}</span> : null}
      </div>
      {body.reason ? (
        // The agent's reason: untrusted, shown as plain text.
        <p className="m-0 whitespace-pre-wrap break-words text-[13px] leading-[1.5] text-(--text-secondary)">
          {body.reason}
        </p>
      ) : null}
      {settled || sent ? (
        <p role="status" className="m-0 text-[13px] font-medium text-(--text-primary)">
          {t(OUTCOME_KEYS[settled ?? 'sending'])}
        </p>
      ) : (
        <form
          className="flex flex-col gap-[10px]"
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          {body.fields.map((field) => (
            <label key={field.id} className="flex min-w-0 flex-col gap-[5px]">
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="min-w-0 truncate font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">
                  {fieldLabel(field)}
                </span>
                {field.required ? <span className={HINT}>{t('required')}</span> : null}
              </span>
              <FieldControl
                field={field}
                value={values[field.id] ?? ''}
                checked={checks[field.id] ?? false}
                disabled={!live || sending}
                onValue={(value) => setValues((prev) => ({ ...prev, [field.id]: value }))}
                onChecked={(checked) => setChecks((prev) => ({ ...prev, [field.id]: checked }))}
              />
            </label>
          ))}
          <span className={HINT}>{unmaskedSecret ? t('unmaskedNote') : t('privacyNote')}</span>
          {body.kind === 'login' ? <span className={HINT}>{t('sessionNote')}</span> : null}
          {error ? (
            <span className="inline-flex min-w-0 items-start gap-[6px] font-sans text-[11.5px] font-normal leading-normal text-(--brand-soft-text)">
              <span className="mt-[2px] flex-none">
                <Icon name="triangle-alert" size={12} color="var(--brand)" />
              </span>
              <span className="min-w-0">{error}</span>
            </span>
          ) : null}
          <div className="flex flex-wrap items-center gap-[8px] border-t border-(--border-subtle) pt-[11px]">
            <button type="submit" className="dsbtn dsbtn-primary xs" disabled={!live || sending}>
              {t('fill')}
            </button>
            <button
              type="button"
              className="chip rounded-sm disabled:cursor-default disabled:opacity-55"
              disabled={!live || sending}
              onClick={() => void answer({ cancel: true })}
            >
              {t('cancel')}
            </button>
            <span className={`ml-auto ${HINT}`}>{t('noSubmit')}</span>
          </div>
        </form>
      )}
    </div>
  )
}

function FieldControl({
  field,
  value,
  checked,
  disabled,
  onValue,
  onChecked
}: {
  field: Field
  value: string
  checked: boolean
  disabled: boolean
  onValue: (value: string) => void
  onChecked: (checked: boolean) => void
}) {
  const label = fieldLabel(field)
  if (field.control === 'checkbox')
    return (
      <input
        type="checkbox"
        className="h-4 w-4"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChecked(event.target.checked)}
      />
    )
  if ((field.control === 'select' || field.control === 'radio') && field.options?.length)
    return (
      <select
        className={INPUT}
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onValue(event.target.value)}
      >
        <option value="" />
        {field.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label || option.value}
          </option>
        ))}
      </select>
    )
  // A secret is a masked input whatever the website renders it with, a textarea included.
  if (field.control === 'textarea' && !field.secret)
    return (
      <textarea
        className={`${INPUT} min-h-16`}
        value={value}
        disabled={disabled}
        aria-label={label}
        {...(field.maxLength ? { maxLength: field.maxLength } : {})}
        onChange={(event) => onValue(event.target.value)}
      />
    )
  // Every secret is masked here, whatever the website does with it.
  const type = field.secret ? 'password' : (INPUT_TYPES[field.control] ?? 'text')
  return (
    <input
      className={INPUT}
      type={type}
      value={value}
      disabled={disabled}
      aria-label={label}
      autoComplete={field.secret ? 'new-password' : 'off'}
      spellCheck={false}
      {...(field.placeholder ? { placeholder: field.placeholder } : {})}
      {...(field.maxLength ? { maxLength: field.maxLength } : {})}
      onChange={(event) => onValue(event.target.value)}
    />
  )
}
