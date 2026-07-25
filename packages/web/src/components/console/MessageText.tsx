'use client'

/**
 * Transcript message renderer. The daemon records the agent's verbatim markdown
 * (posted to Slack as a Block Kit `markdown` block), and user/inbound rows carry
 * Slack control syntax — `slackToMarkdown` normalizes both into CommonMark, then
 * react-markdown renders it. Single newlines become line breaks (remark-breaks) to
 * match how Slack renders a `markdown` block.
 *
 * Safety: react-markdown skips raw HTML and sanitizes URLs (drops `javascript:`)
 * by default; we only widen that to force external links into a new, opener-isolated
 * tab. Styling lives under `.mdtxt` (compact, inline — distinct from `.md-body`).
 */

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { slackToMarkdown } from './slack-mrkdwn'

// Transcript rows from ACP aren't section-split like Slack posts, so a pathological
// reasoning row can be huge. react-markdown + remark plugins are superlinear on very
// large strings, so above this cap we skip parsing and render cheap pre-wrapped text.
const MAX_PARSE = 100_000

export function MessageText({ text }: { text: string }) {
  if (text.length > MAX_PARSE) {
    return (
      <div className="mdtxt">
        <p className="whitespace-pre-wrap">{text}</p>
      </div>
    )
  }
  return (
    <div className="mdtxt">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          a: ({ children, node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          )
        }}
      >
        {slackToMarkdown(text)}
      </ReactMarkdown>
    </div>
  )
}
