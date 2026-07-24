'use client'

// Rendered-markdown preview shared by the workspace file browser and memory viewer.
// Split into its own module so react-markdown + remark-gfm are loaded lazily (via
// next/dynamic) and never ship in the main console bundle.
//
// Safety: react-markdown v9 escapes raw HTML and sanitizes URLs by default, so
// untrusted agent-authored files can't inject scripts. A caller may opt in to
// resolving a link as an in-app action or marking it unavailable; every unresolved
// URL keeps the existing opener-isolated new-tab behavior.

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export type MarkdownLinkResolution = { kind: 'action'; onActivate: () => void } | { kind: 'blocked' }

export default function MarkdownView({
  content,
  resolveLink
}: {
  content: string
  resolveLink?: (href: string) => MarkdownLinkResolution | undefined
}) {
  return (
    <div className="md-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, node: _node, href, title, ...props }) => {
            const resolved = href !== undefined ? resolveLink?.(href) : undefined
            if (resolved?.kind === 'action') {
              return (
                <button
                  type="button"
                  title={title}
                  className="cursor-pointer border-0 bg-transparent p-0 text-(--text-link) hover:underline"
                  onClick={resolved.onActivate}
                >
                  {children}
                </button>
              )
            }
            if (resolved?.kind === 'blocked') {
              return (
                <span
                  title={title ?? 'Unavailable in this preview'}
                  aria-disabled="true"
                  className="text-(--text-link)"
                >
                  {children}
                </span>
              )
            }
            return (
              <a {...props} href={href} title={title} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            )
          }
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
