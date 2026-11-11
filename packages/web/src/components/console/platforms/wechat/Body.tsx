// No 'use client' here: rendered only inside ModalProvider's tree (the client boundary).

import { useTranslations } from 'next-intl'
import { PlatformMark } from '@/components/marks'
import { Button, Icon } from '@/components/ui'
import type { Agent } from '@/lib/data'
import type { WizardHost } from '../contract'
import { usePublishedFooter, usePublishedIdentityChrome } from '../publish'
import { useWeChatLogin, WeChatLoginView } from './login'

/** WeChat's pane: explain the one-person binding, then run the CP's QR login; the token never reaches the browser. */
export function WeChatWizardBody({ agent, host }: { agent: Agent; host: WizardHost }) {
  const t = useTranslations('Platforms.wechat')
  const { invalidate, setError } = host
  const state = useWeChatLogin({ agentId: agent.id, onCompleted: () => invalidate() })

  async function start() {
    setError(null)
    const message = await state.start()
    if (message) setError(message)
  }

  // The CP installs out of band, and the host draws no primary without the identity chrome, so Done is inline.
  usePublishedFooter(host, { label: t('footer.done'), enabled: false, onSubmit: () => {}, hidden: true })
  // A bot is one member's chat with one agent, so there is nothing to reuse and no create/existing choice.
  usePublishedIdentityChrome(host, { hidden: true })

  if (host.mode !== 'create') return null
  return (
    <div className="mb-4 flex flex-col gap-3 rounded-[9px] border border-(--border-subtle) bg-(--surface-app) p-[14px]">
      <div className="flex gap-[10px]">
        <span className="imark h-5 w-5 flex-none border-0 bg-transparent">
          <PlatformMark platform="wechat" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-sans text-[12.5px] font-semibold leading-normal text-(--text-secondary)">
            {t('intro.title')}
          </div>
          <p className="m-0 mt-[3px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
            {t('intro.body', { agent: agent.name })}
          </p>
          <p className="m-0 mt-[3px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
            {t('intro.experimental')}
          </p>
        </div>
      </div>
      <div className="flex items-start gap-2 rounded-md bg-(--status-paused-soft) px-[10px] py-2 font-sans text-[12px] font-medium leading-[1.5] text-(--text-secondary)">
        <Icon name="triangle-alert" size={14} color="var(--status-paused)" className="mt-[2px] flex-none" />
        <span>{t('intro.counterpart')}</span>
      </div>
      {state.phase === 'idle' ? (
        <div>
          <Button disabled={state.starting} onClick={() => void start()}>
            <Icon name="qr-code" size={14} />
            {state.starting ? t('starting') : t('start')}
          </Button>
        </div>
      ) : (
        <WeChatLoginView state={state} onRetry={() => void start()} onDone={() => host.close()} />
      )}
    </div>
  )
}
