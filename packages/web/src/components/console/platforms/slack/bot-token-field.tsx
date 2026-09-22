// No 'use client' here: rendered only inside client boundaries (ModalProvider's tree and the Integrations view).

import { useTranslations } from 'next-intl'

/** A pasted value can only be a Bot User OAuth Token when it carries Slack's `xoxb-` prefix. */
export function slackBotTokenOk(token: string): boolean {
  return token.trim().startsWith('xoxb-')
}

/** The Bot token input shared by the manual install and the token replacement. */
export function SlackBotTokenField({
  value,
  onChange,
  invalid,
  autoFocus
}: {
  value: string
  onChange: (next: string) => void
  invalid?: boolean
  autoFocus?: boolean
}) {
  const t = useTranslations('Platforms.slack.tokens')
  return (
    <label className="fld">
      <span className="fldlbl">{t('botToken')}</span>
      <input
        className={`inp mn ${invalid ? 'border-(--status-error)' : ''}`}
        placeholder={t('botPlaceholder')}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}
