'use client'

import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui'

/** A native MCP App dialog that cannot show its surface — another organization's intent, a
 *  resource the reader may not edit, or one that is simply gone. Says which, and closes. */
export function NativeDialogNotice({ heading, text, onClose }: { heading: string; text: string; onClose: () => void }) {
  const t = useTranslations('Common.actions')
  return (
    <>
      <div className="modalhead">{heading}</div>
      <div className="modalbody" role="status">
        {text}
      </div>
      <div className="modalfoot">
        <Button variant="secondary" onClick={onClose}>
          {t('close')}
        </Button>
      </div>
    </>
  )
}
