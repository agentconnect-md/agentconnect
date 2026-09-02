'use client'

// The facts behind a Linear delivery ({@link WebPlatformModule.turnFacts}): the issue, its team,
// who delegated it, and the description Linear handed the agent — rendered as the markdown it
// is, never as the XML-shaped context the prompt carries. Earlier comments and workspace
// guidance follow when the delivery had them.

import type { UserTurnBody } from '@agentconnect.md/protocol'
import { linearDescriptionMarkdown } from '@/lib/user-turn-body'
import { MarkdownText } from '../../MessageText'
import { FactRow, FactRows } from '../../turn-facts-rows'

export function LinearTurnFacts({ body }: { body: UserTurnBody }) {
  const facts = body.linear
  if (!facts) return null
  const { issue, team } = facts
  const issueLabel = [issue.identifier, issue.title].filter(Boolean).join(' · ')
  const teamLabel = team?.name ? `${team.name}${team.key ? ` (${team.key})` : ''}` : (team?.key ?? '')
  const description = facts.description ? linearDescriptionMarkdown(facts.description) : undefined
  return (
    <>
      <FactRows>
        <FactRow label="Issue">
          {issue.url ? (
            <a className="lnk" href={issue.url} target="_blank" rel="noopener noreferrer">
              {issueLabel || issue.url}
            </a>
          ) : (
            issueLabel
          )}
        </FactRow>
        <FactRow label="Team">{teamLabel}</FactRow>
        <FactRow label="Delegated by">{facts.delegatedBy ?? ''}</FactRow>
      </FactRows>
      {description && (
        <div className="mt-2">
          <p className="mb-[2px] font-sans text-[12px] leading-[1.6] text-(--text-tertiary)">Description</p>
          {description.parsed ? (
            <MarkdownText text={description.markdown || '_(empty)_'} />
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-[1.5] text-(--text-primary)">
              {description.markdown}
            </pre>
          )}
        </div>
      )}
      {facts.comments?.length ? (
        <div className="mt-2">
          <p className="mb-[2px] font-sans text-[12px] leading-[1.6] text-(--text-tertiary)">Earlier comments</p>
          {facts.comments.map((comment, index) => (
            <div key={index} className="mt-1 border-l-2 border-(--border-subtle) pl-2 [border-radius:0]">
              {comment.userId && (
                <p className="font-sans text-[11.5px] leading-normal text-(--text-tertiary)">{comment.userId}</p>
              )}
              {comment.body && <MarkdownText text={comment.body} />}
            </div>
          ))}
        </div>
      ) : null}
      {facts.guidance && (
        <div className="mt-2">
          <p className="mb-[2px] font-sans text-[12px] leading-[1.6] text-(--text-tertiary)">Workspace guidance</p>
          <MarkdownText text={facts.guidance} />
        </div>
      )}
      {facts.truncated && (
        <p className="mt-1 font-sans text-[11.5px] leading-normal text-(--text-tertiary)">
          Context truncated by the relay.
        </p>
      )}
    </>
  )
}
