'use client'

/**
 * Transcript message renderer — the host side of §10's `textRenderer` seam.
 *
 * ONE RENDERER PER ROW, RESOLVED FROM THE ROW'S PLATFORM. `platform` is the
 * key the owning platform module is looked up under; a module that publishes a
 * `textRenderer` renders its own platform's rows, and everything else — every
 * module that publishes none, and every id no module claims — gets
 * {@link SlackMrkdwnText}, the core default below. The lookup happens HERE,
 * inside the per-row component, and not once per transcript: a merged
 * conversation interleaves rows from several sources by event time
 * (`MergedRow.sourcePlatform`), so a renderer hoisted out of the row loop
 * would render one platform's rows with another's semantics.
 *
 * NO MODULE OVERRIDES IT TODAY, deliberately: §10 ships the registry with the
 * Slack renderer as the default for all chat platforms and lands per-platform
 * overrides separately, each with its own visual review. So this resolves to
 * the same renderer for every row that reaches it — the seam is what changed,
 * not a pixel.
 */

import { memo, type ComponentType } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { platformTextRenderer } from './platforms/registry'
import { slackToMarkdown } from './slack-mrkdwn'

// Transcript rows from ACP aren't section-split like Slack posts, so a pathological
// reasoning row can be huge. react-markdown + remark plugins are superlinear on very
// large strings, so above this cap we skip parsing and render cheap pre-wrapped text.
const MAX_PARSE = 100_000

// The only targets that reach a reader as a working link; anything else renders as its label.
// A leading slash passes react-markdown's sanitizer as a same-origin relative URL, so a host path a
// runtime linked used to render an anchor opening this console on a path it does not serve. The
// daemon flattens those before delivery now; this keeps rows recorded before that from 404ing.
const WEB_HREF = /^(?:https?:|mailto:)/i

/**
 * The core default renderer: Slack mrkdwn semantics over a CommonMark
 * pipeline. The daemon records the agent's verbatim markdown (posted to Slack
 * as a Block Kit `markdown` block), and user/inbound rows carry Slack control
 * syntax — `slackToMarkdown` normalizes both into CommonMark, then
 * react-markdown renders it. Single newlines become line breaks (remark-breaks)
 * to match how Slack renders a `markdown` block.
 *
 * Core rather than the Slack module's `textRenderer` because three other
 * platforms render through it: as Slack's member it would leave Telegram,
 * Discord and Feishu reaching into another module. It moves into
 * `platforms/slack/` on the day Slack's semantics stop being everyone's.
 *
 * Safety: react-markdown skips raw HTML and sanitizes URLs (drops `javascript:`)
 * by default; we only widen that to force external links into a new, opener-isolated
 * tab. Styling lives under `.mdtxt` (compact, inline — distinct from `.md-body`).
 */
export const SlackMrkdwnText: ComponentType<{ text: string }> = function SlackMrkdwnText({ text }) {
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
        {slackToMarkdown(text)}
      </ReactMarkdown>
    </div>
  )
}

/** CommonMark as written — a GitHub or GitLab body — with the same link policy and the same
 *  `.mdtxt` styling, and none of the Slack control-syntax normalization the default applies. */
export const MarkdownText: ComponentType<{ text: string }> = function MarkdownText({ text }) {
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
        remarkPlugins={[remarkGfm]}
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

// memo: the transcript re-renders on every unrelated state change in
// SessionDetailView (composer keystrokes, the 1s duration tick, expanding one turn's
// work), and without this EVERY row re-runs the resolved renderer's whole pipeline.
// Both props are plain strings, so shallow compare is exact — which is also why
// `textRenderer` is a ComponentType and not a `(text, ctx) => ReactNode` function:
// the memo boundary has to sit OUTSIDE the per-platform work.
export const MessageText = memo(function MessageText({ text, platform }: { text: string; platform?: string }) {
  const Renderer = platformTextRenderer(platform) ?? SlackMrkdwnText
  return <Renderer text={text} />
})
