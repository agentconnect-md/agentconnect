'use client'

// Transcript message renderer: one renderer per row, resolved from the row's own platform (a module's override, else the default below).

import { memo, type ComponentType } from 'react'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { SafeMarkdownText } from './markdown-text'
import { platformTextRenderer } from './platforms/registry'
import { slackToMarkdown } from './slack-mrkdwn'

const SLACK_MARKDOWN_PLUGINS = [remarkGfm, remarkBreaks]

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
  return <SafeMarkdownText text={text} transform={slackToMarkdown} remarkPlugins={SLACK_MARKDOWN_PLUGINS} />
}

/** CommonMark as written — a GitHub or GitLab body — with the same link policy and the same
 *  `.mdtxt` styling, and none of the Slack control-syntax normalization the default applies. */
export { MarkdownText } from './markdown-text'

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
