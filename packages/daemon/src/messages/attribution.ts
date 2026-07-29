/**
 * Platform-neutral attribution sentence. Callers render and escape each part
 * before passing it here so GitHub Markdown, Slack mrkdwn, and Slack fallback
 * text can keep their own link syntax.
 */
export interface AttributionMessageParts {
  agent: string
  runtime?: string
  model?: string
  renderSession?: (label: string) => string | undefined
}

/** Raw reply identity shared by platform renderers before each platform applies
 * its own escaping and link syntax. */
export interface ReplyAttributionInfo {
  botName: string
  botUrl: string
  runtime: string
  model: string
  sessionUrl: string
}

const OPEN_IN_SESSION_LABEL = 'open in session'

function present(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0
}

/** Canonical visible order: sender, optional runtime/model identity, session link. */
export function renderAttributionMessage({ agent, runtime, model, renderSession }: AttributionMessageParts): string {
  const identity = [runtime, model].filter(present)
  const sender = identity.length > 0 ? `sent by ${agent} (${identity.join(' · ')})` : `sent by ${agent}`
  const session = renderSession?.(OPEN_IN_SESSION_LABEL)
  return present(session) ? `${sender} · ${session}` : sender
}
