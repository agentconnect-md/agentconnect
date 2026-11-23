'use client'

import type { ComponentProps, ComponentType } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// Transcript rows from ACP aren't section-split like Slack posts, so a pathological
// reasoning row can be huge. react-markdown + remark plugins are superlinear on very
// large strings, so above this cap we skip parsing and render cheap pre-wrapped text.
const MAX_PARSE = 100_000

// The only targets that reach a reader as a working link; anything else renders as its label.
// A leading slash passes react-markdown's sanitizer as a same-origin relative URL, so a host path a
// runtime linked used to render an anchor opening this console on a path it does not serve. The
// daemon flattens those before delivery now; this keeps rows recorded before that from 404ing.
const WEB_HREF = /^(?:https?:\/\/\S+|mailto:\S+)$/i

type MarkdownPlugins = NonNullable<ComponentProps<typeof ReactMarkdown>['remarkPlugins']>
type MarkdownComponents = NonNullable<ComponentProps<typeof ReactMarkdown>['components']>

const SAFE_MARKDOWN_COMPONENTS: MarkdownComponents = {
  a: ({ children, node: _node, ...props }) =>
    WEB_HREF.test(props.href ?? '') ? (
      <a {...props} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <>{children}</>
    ),
  img: ({ node: _node, src, alt }) => {
    const target = typeof src === 'string' ? src : ''
    const label = alt || target
    return WEB_HREF.test(target) ? (
      <a href={target} target="_blank" rel="noopener noreferrer">
        {label}
      </a>
    ) : (
      <>{label}</>
    )
  }
}

const DEFAULT_MARKDOWN_PLUGINS: MarkdownPlugins = [remarkGfm]

/** Shared bounded-size CommonMark + link-policy renderer used by both `MarkdownText` and `SlackMrkdwnText`. */
export function SafeMarkdownText({
  text,
  transform,
  remarkPlugins
}: {
  text: string
  transform?: (raw: string) => string
  remarkPlugins: MarkdownPlugins
}) {
  if (text.length > MAX_PARSE) {
    return (
      <div className="mdtxt">
        <p className="whitespace-pre-wrap">{text}</p>
      </div>
    )
  }
  return (
    <div className="mdtxt">
      <ReactMarkdown remarkPlugins={remarkPlugins} components={SAFE_MARKDOWN_COMPONENTS}>
        {transform ? transform(text) : text}
      </ReactMarkdown>
    </div>
  )
}

/** CommonMark + GFM as written — e.g. Mattermost, GitHub, or GitLab bodies — with the same link
 *  policy and `.mdtxt` styling as `SlackMrkdwnText`, without Slack mrkdwn normalization or `remark-breaks`. */
export const MarkdownText: ComponentType<{ text: string }> = function MarkdownText({ text }) {
  return <SafeMarkdownText text={text} remarkPlugins={DEFAULT_MARKDOWN_PLUGINS} />
}
