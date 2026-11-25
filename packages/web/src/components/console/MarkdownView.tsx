'use client'

// Lazy-loaded Markdown preview: frontmatter as a table, raw HTML escaped, URLs sanitized unless a caller resolves them.

import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import { frontmatterTableHandler } from '@/components/console/frontmatter'

export type MarkdownLinkResolution = { kind: 'action'; onActivate: () => void } | { kind: 'blocked' }

export default function MarkdownView({
  content,
  resolveLink,
  resolveImage
}: {
  content: string
  resolveLink?: (href: string) => MarkdownLinkResolution | undefined
  /** A caller-made `blob:` URL for an image source, used instead of the source; anything else keeps the default sanitizing. */
  resolveImage?: (src: string) => string | undefined
}) {
  return (
    <div className="md-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkFrontmatter]}
        urlTransform={(url, key, node) =>
          (resolveImage && key === 'src' && node.tagName === 'img' ? resolveImage(url) : undefined) ??
          defaultUrlTransform(url)
        }
        remarkRehypeOptions={{ handlers: { yaml: frontmatterTableHandler } }}
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
