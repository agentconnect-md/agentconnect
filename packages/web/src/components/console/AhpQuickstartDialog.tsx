'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button, Icon } from '@/components/ui'
import { agentLabel, type Agent } from '@/lib/data'
import { agentApiRelayUrl, agentChatUrl, ahpDeploymentAccess, ahpQuickstart } from '@/lib/agent-api'
import { Scrim } from './Scrim'

// AHP uses approved full keys; never list or create chat-only keys for this endpoint.
export function AhpQuickstartDialog({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const t = useTranslations('Integrations.api')
  const [copied, setCopied] = useState(false)
  const url = agentChatUrl('ahp', agent.id, agentApiRelayUrl())
  const example = url ? ahpQuickstart(url) : undefined
  const access = ahpDeploymentAccess()
  return (
    <Scrim onEscape={onClose}>
      <div className="modal max-w-[920px]" role="dialog" aria-modal="true" aria-label={t('quickstart')}>
        <div className="modalhead">
          <span className="min-w-0 flex-1 font-sans text-[16px] font-semibold leading-normal">
            AHP v1 · {agentLabel(agent)}
          </span>
          <button className="iconbtn" aria-label={t('close')} onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modalbody flex flex-col gap-3">
          {access !== 'public' && <p className="psub mt-0">{t(access === 'off' ? 'ahpOff' : 'ahpPilot')}</p>}
          <p className="psub mt-0">{t('ahpAccess')}</p>
          {url && (
            <>
              <span className="fldlbl">{t('ahpEndpoint')}</span>
              <code className="mono break-all text-[12px]">{url}</code>
            </>
          )}
          {example && (
            <>
              <div className="flex items-center justify-between">
                <span className="mono text-[12px]">{example.file}</span>
                <button
                  className="iconbtn"
                  title={t('copySnippet')}
                  onClick={() => {
                    void navigator.clipboard.writeText(example.code).then(
                      () => setCopied(true),
                      () => {}
                    )
                  }}
                >
                  <Icon name={copied ? 'check' : 'copy'} size={14} />
                </button>
              </div>
              <pre className="overflow-x-auto rounded-md bg-(--surface-sunken) p-3 font-mono text-[12px]">
                <code>{example.code}</code>
              </pre>
            </>
          )}
        </div>
        <div className="modalfoot">
          <a
            className="lnk text-[12px]"
            href="https://github.com/microsoft/agent-host-protocol"
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('docs')}
          </a>
          <div className="flex-1" />
          <Button variant="primary" onClick={onClose}>
            {t('done')}
          </Button>
        </div>
      </div>
    </Scrim>
  )
}
