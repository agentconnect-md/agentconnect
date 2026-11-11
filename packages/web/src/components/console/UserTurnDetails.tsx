'use client'

// What a delivery bubble folds behind "more": the facts the daemon read the turn from
// (transcript-full-tool-body.md §9), formatted per platform. The bubble's text is what the
// person said; this is where it came from. A Linear row resolves its module's formatter
// through the registry; a code-host row uses the host's own, since GitHub and GitLab are
// not platform modules. The raw prompt is never shown — it is the model's, not the reader's.

import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import type {
  CodehostTurnFacts as CodehostFacts,
  SessionMessageTurnFacts as MessageFacts,
  UserTurnBody
} from '@agentconnect.md/protocol'
import { shortSha } from '@/lib/user-turn-body'
import { azureDevOpsPullRequestLabel, azureDevOpsPullRequestUrl } from '@/lib/azure-devops-repositories'
import { MarkdownText } from './MessageText'
import { platformTurnFacts } from './platforms/registry'
import { FactRow, FactRows } from './turn-facts-rows'

/** GitHub and GitLab share one shape: who, which revision, how it is answered, then the body. */
export function CodehostTurnFacts({ facts }: { facts: CodehostFacts }) {
  const t = useTranslations('Sessions.userTurnDetails')
  const { author, revision, subject } = facts
  const from = author?.login
    ? `${author.login}${author.association ? ` · ${author.association.toLowerCase()}` : ''}`
    : ''
  // An Azure DevOps pull request is named `{organization}/{project}/{repository}!{id}` (azure-devops-integration.md §11.8).
  const azurePull = facts.provider === 'azure-devops' && subject.number !== undefined && subject.kind !== 'push'
  const number = subject.number === undefined ? '' : azurePull ? `!${subject.number}` : `#${subject.number}`
  const subjectUrl =
    subject.url ??
    (azurePull && subject.repo ? (azureDevOpsPullRequestUrl(subject.repo, subject.number!) ?? undefined) : undefined)
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
          {subjectUrl ? (
            <a className="lnk" href={subjectUrl} target="_blank" rel="noopener noreferrer">
              {azurePull && subject.repo
                ? azureDevOpsPullRequestLabel(subject.repo, subject.number!)
                : `${subject.repo ?? subjectUrl}${number ? ` · ${number}` : ''}`}
            </a>
          ) : azurePull && subject.repo ? (
            azureDevOpsPullRequestLabel(subject.repo, subject.number!)
          ) : (
            [subject.repo, number].filter(Boolean).join(' · ')
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
        <FactRow label={t('review')}>{facts.review ? t(`reviewValues.${facts.review}`) : ''}</FactRow>
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

/** The one line above another agent's message or reply, naming that agent; a task's report or instruction has none, and neither does a sender with no name. */
export function SessionMessageCaption({ facts }: { facts: MessageFacts }) {
  const t = useTranslations('Sessions.userTurnDetails')
  const agent = facts.source.label
  if (!agent || (facts.kind !== 'call' && facts.kind !== 'reply')) return null
  return (
    <p className="mb-1 font-sans text-[11.5px] leading-normal text-(--text-tertiary)">
      {t(`messageCaption.${facts.kind}`, { agent })}
    </p>
  )
}

/** A session message's header facts and the guidance the agent received around its body, verbatim. */
export function SessionMessageTurnFacts({ facts }: { facts: MessageFacts }) {
  const t = useTranslations('Sessions.userTurnDetails')
  const mono = (value: string | undefined) => (value ? <span className="font-mono text-[11.5px]">{value}</span> : '')
  return (
    <>
      <FactRows>
        <FactRow label={t('from')}>
          {facts.source.label ? `${facts.source.label} · ${facts.source.agentId}` : facts.source.agentId}
        </FactRow>
        <FactRow label={t('session')}>{mono(facts.source.sessionId)}</FactRow>
        <FactRow label={t('message')}>{mono(facts.messageId)}</FactRow>
        <FactRow label={t('inReplyTo')}>{mono(facts.inReplyTo)}</FactRow>
        <FactRow label={t('awaitsReply')}>{facts.replyRequested === true ? t('yes') : ''}</FactRow>
      </FactRows>
      {facts.notes?.length ? (
        <div className="mt-2">
          <p className="font-sans text-[11.5px] leading-normal text-(--text-tertiary)">{t('notes')}</p>
          {facts.notes.map((note, i) => (
            <p
              key={i}
              className="mt-1 whitespace-pre-wrap break-words font-mono text-[11.5px] leading-normal text-(--text-secondary)"
            >
              {note}
            </p>
          ))}
        </div>
      ) : null}
    </>
  )
}

function SessionMessageFold({ body }: { body: UserTurnBody }) {
  return body.sessionMessage ? <SessionMessageTurnFacts facts={body.sessionMessage} /> : null
}

/** The formatter for this body, if any: a session message's own, the platform module's, else the host's code-host one. */
function factsRenderer(body: UserTurnBody, platform?: string): ComponentType<{ body: UserTurnBody }> | undefined {
  if (body.sessionMessage) return SessionMessageFold
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
export function UserTurnDetails({
  body,
  platform,
  children
}: {
  body: UserTurnBody
  platform?: string
  /** The bubble's text, which a session message folds with its facts. */
  children?: ReactNode
}) {
  const t = useTranslations('Sessions.userTurnDetails')
  const [open, setOpen] = useState(false)
  const Facts = factsRenderer(body, platform)
  // A report or an instruction can run to pages, so "more" sits under its first lines (auto-session-mode.md §6.9.5).
  const text = children ? (
    <FoldedText folded={body.sessionMessage !== undefined && Facts !== undefined && !open}>{children}</FoldedText>
  ) : null
  if (!Facts) return text
  return (
    <>
      {text}
      <TurnFactsFold open={open} onToggle={() => setOpen((v) => !v)} label={open ? t('less') : t('more')}>
        <Facts body={body} />
      </TurnFactsFold>
    </>
  )
}

/** Six lines of the bubble's text, at its 13.5px on a 1.55 line. */
const FOLDED_TEXT = 'max-h-[126px] overflow-hidden'

/** A bubble's text, cut to its first lines while folded and faded out where it was cut. */
function FoldedText({ folded, children }: { folded: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [cut, setCut] = useState(false)
  useEffect(() => {
    const el = ref.current
    setCut(folded && el !== null && el.scrollHeight > el.clientHeight + 1)
  }, [folded, children])
  return (
    <div
      ref={ref}
      data-folded-text={folded ? (cut ? 'cut' : 'whole') : undefined}
      className={
        folded
          ? `${FOLDED_TEXT} ${cut ? '[mask-image:linear-gradient(to_bottom,black_60%,transparent)]' : ''}`
          : undefined
      }
    >
      {children}
    </div>
  )
}

function TurnFactsFold({
  open,
  onToggle,
  label,
  children
}: {
  open: boolean
  onToggle: () => void
  label: string
  children: ReactNode
}) {
  return (
    <div data-turn-details>
      <button
        type="button"
        className="mt-[6px] cursor-pointer font-sans text-[12px] font-normal leading-normal text-(--text-tertiary) hover:text-(--text-secondary)"
        aria-expanded={open}
        onClick={onToggle}
      >
        {label}
      </button>
      {open && <div className="mt-[10px] border-t border-(--border-subtle) pt-[10px]">{children}</div>}
    </div>
  )
}
