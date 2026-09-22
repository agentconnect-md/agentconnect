'use client'

// What a delivery bubble folds behind "more": the facts the daemon read the turn from
// (transcript-full-tool-body.md §9), formatted per platform. The bubble's text is what the
// person said; this is where it came from. A Linear row resolves its module's formatter
// through the registry; a code-host row uses the host's own, since GitHub and GitLab are
// not platform modules. The raw prompt is never shown — it is the model's, not the reader's.

import { useState, type ComponentType } from 'react'
import { useTranslations } from 'next-intl'
import type { CodehostTurnFacts as CodehostFacts, UserTurnBody } from '@agentconnect.md/protocol'
import { shortSha } from '@/lib/user-turn-body'
import { MarkdownText } from './MessageText'
import { platformTurnFacts } from './platforms/registry'
import { FactRow, FactRows } from './turn-facts-rows'

/** How a code-host delivery is answered, as a person would say it. */
const REVIEW_LABEL: Record<NonNullable<CodehostFacts['review']>, string> = {
  generation: 'generation',
  inline: 'inline',
  conversation: 'conversation'
}

/** GitHub and GitLab share one shape: who, which revision, how it is answered, then the body. */
export function CodehostTurnFacts({ facts }: { facts: CodehostFacts }) {
  const t = useTranslations('Sessions.userTurnDetails')
  const { author, revision, subject } = facts
  const from = author?.login
    ? `${author.login}${author.association ? ` · ${author.association.toLowerCase()}` : ''}`
    : ''
  const revisionText =
    revision?.base && revision.head
      ? `${shortSha(revision.base)} → ${shortSha(revision.head)}`
      : revision?.head
        ? shortSha(revision.head)
        : ''
  return (
    <>
      <FactRows>
        <FactRow label={t('subject')}>
          {subject.url ? (
            <a className="lnk" href={subject.url} target="_blank" rel="noopener noreferrer">
              {subject.repo ?? subject.url}
              {subject.number !== undefined ? ` · #${subject.number}` : ''}
            </a>
          ) : (
            [subject.repo, subject.number !== undefined ? `#${subject.number}` : ''].filter(Boolean).join(' · ')
          )}
        </FactRow>
        <FactRow label={t('event')}>{facts.event}</FactRow>
        <FactRow label={t('from')}>{from}</FactRow>
        <FactRow label={t('revision')}>
          {revisionText ? <span className="font-mono text-[11.5px]">{revisionText}</span> : ''}
        </FactRow>
        <FactRow label={t('ref')}>{facts.ref ?? ''}</FactRow>
        <FactRow label={t('environment')}>{facts.environment ?? ''}</FactRow>
        <FactRow label={t('draft')}>{facts.draft === true ? t('yes') : ''}</FactRow>
        <FactRow label={t('labels')}>{facts.labels?.length ? facts.labels.join(', ') : ''}</FactRow>
        <FactRow label={t('review')}>{facts.review ? t(`reviewValues.${REVIEW_LABEL[facts.review]}`) : ''}</FactRow>
      </FactRows>
      {facts.body && (
        <div className="mt-2">
          <MarkdownText text={facts.body} />
          {facts.truncated && (
            <p className="mt-1 font-sans text-[11.5px] leading-normal text-(--text-tertiary)">{t('bodyTruncated')}</p>
          )}
        </div>
      )}
    </>
  )
}

/** The formatter for this body, if any: the platform module's own, else the host's code-host one. */
function factsRenderer(body: UserTurnBody, platform?: string): ComponentType<{ body: UserTurnBody }> | undefined {
  const own = platformTurnFacts(platform)
  if (own) return own
  if (body.codehost) return CodehostFold
  return undefined
}

function CodehostFold({ body }: { body: UserTurnBody }) {
  return body.codehost ? <CodehostTurnFacts facts={body.codehost} /> : null
}

/**
 * The fold itself: a bare "more" under the bubble text, and under it — on demand — the facts.
 * Collapsed by default, per bubble, remembered only while the row is mounted. Renders nothing
 * when no formatter claims the body, so a row from a platform with facts but no formatter
 * stays exactly the bubble it was.
 */
export function UserTurnDetails({ body, platform }: { body: UserTurnBody; platform?: string }) {
  const t = useTranslations('Sessions.userTurnDetails')
  const [open, setOpen] = useState(false)
  const Facts = factsRenderer(body, platform)
  if (!Facts) return null
  return (
    <div data-turn-details>
      <button
        type="button"
        className="mt-[6px] cursor-pointer font-sans text-[12px] font-normal leading-normal text-(--text-tertiary) hover:text-(--text-secondary)"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? t('less') : t('more')}
      </button>
      {open && (
        <div className="mt-[10px] border-t border-(--border-subtle) pt-[10px]">
          <Facts body={body} />
        </div>
      )}
    </div>
  )
}
