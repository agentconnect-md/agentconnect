'use client'

// A Gate Try sample: ordered history lines with sender ids, then the current message (decisions.md §9.3).

import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'

export interface SampleLine {
  sender: string
  text: string
}

export function DecisionSampleFields({
  history,
  current,
  onHistory,
  onCurrent
}: {
  history: SampleLine[]
  current: string
  onHistory: (next: SampleLine[]) => void
  onCurrent: (next: string) => void
}) {
  const t = useTranslations('Decisions')
  const update = (index: number, patch: Partial<SampleLine>) =>
    onHistory(history.map((row, at) => (at === index ? { ...row, ...patch } : row)))
  return (
    <>
      <div className="fld">
        <span className="fldlbl">{t('try.history')}</span>
        {history.map((line, index) => (
          <div
            key={index}
            className="grid grid-cols-[104px_minmax(0,1fr)_26px] items-start gap-[7px] max-desktop:grid-cols-[minmax(0,1fr)_26px]"
          >
            <input
              value={line.sender}
              onChange={(event) => update(index, { sender: event.target.value })}
              placeholder={t('try.senderPlaceholder')}
              aria-label={t('gateTry.senderLabel', { index: index + 1 })}
              className="inp mn h-8 min-h-0"
            />
            <input
              value={line.text}
              onChange={(event) => update(index, { text: event.target.value })}
              placeholder={t('try.messagePlaceholder')}
              aria-label={t('gateTry.historyLabel', { index: index + 1 })}
              className="inp h-8 min-h-0 max-desktop:col-start-1 max-desktop:row-start-2"
            />
            <button
              type="button"
              title={t('try.removeMessage')}
              aria-label={t('try.removeMessage')}
              onClick={() => onHistory(history.filter((_, at) => at !== index))}
              className="flex h-8 w-[26px] items-center justify-center rounded-sm border-0 bg-transparent text-(--text-tertiary) hover:bg-(--surface-hover) hover:text-(--text-primary)"
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="lnk self-start gap-[6px] text-[12.5px] font-medium"
          onClick={() => onHistory([...history, { sender: '@user', text: '' }])}
        >
          <Icon name="plus" size={14} />
          {t('try.addMessage')}
        </button>
      </div>
      <div className="fld">
        <span className="fldlbl">{t('try.current')}</span>
        <textarea
          value={current}
          rows={2}
          onChange={(event) => onCurrent(event.target.value)}
          placeholder={t('try.currentPlaceholder')}
          aria-label={t('try.current')}
          className="inp block w-full resize-y"
        />
      </div>
    </>
  )
}
