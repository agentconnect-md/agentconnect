/**
 * Build a Slack permalink to a thread from the pieces the daemon already holds:
 * the workspace's base URL (auth.test's `url`, e.g. "https://acme.slack.com/"),
 * the channel id and the thread's ROOT ts.
 *
 * Slack's canonical message permalink is `<base>/archives/<channel>/p<ts>`, where
 * `<ts>` is the message ts with its dot stripped (e.g. "1710799200.123456" →
 * "p1710799200123456"). This is exactly what `chat.getPermalink` returns for a
 * root message — opening it lands on that message and, when it has replies, its
 * thread. Since a session is keyed by its thread-root ts (`thread_ts ?? ts`), the
 * root permalink IS the link to the thread, so no `chat.getPermalink` round-trip
 * is needed.
 *
 * Returns undefined when any input is missing, so callers can spread it away.
 */
export function slackThreadUrl(
  workspaceUrl: string | undefined,
  channel: string,
  threadTs: string
): string | undefined {
  if (!workspaceUrl || !channel || !threadTs) return undefined
  const base = workspaceUrl.replace(/\/+$/, '') // auth.test's url has a trailing slash
  const p = `p${threadTs.replace('.', '')}`
  return `${base}/archives/${channel}/${p}`
}
