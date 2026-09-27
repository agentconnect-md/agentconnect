// No 'use client' here: loaded lazily from `renderer.tsx`, inside the transcript's client tree.

import ReactMarkdown from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'

// What Google Chat renders in Markdown mode (Google's "Format messages" guide); any other element is unwrapped to its text.
export const GOOGLE_CHAT_ELEMENTS = [
  'p',
  'br',
  'strong',
  'em',
  'del',
  'code',
  'pre',
  'a',
  'ul',
  'ol',
  'li',
  'blockquote'
]

// The same link policy and parse cap as the console's default renderer (`MessageText`).
const WEB_HREF = /^(?:https?:|mailto:)/i
const MAX_PARSE = 100_000

/** A Google Chat row as Chat shows it: bold, italic, strikethrough, code, links, lists and quotes, single newlines kept. */
export default function GoogleChatMarkdownText({ text }: { text: string }) {
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
        allowedElements={GOOGLE_CHAT_ELEMENTS}
        unwrapDisallowed
        components={{
          a: ({ children, node: _node, ...props }) =>
            WEB_HREF.test(props.href ?? '') ? (
              <a {...props} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ) : (
              <>{children}</>
            )
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
