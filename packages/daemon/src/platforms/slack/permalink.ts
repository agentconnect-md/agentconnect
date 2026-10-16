/** A thread's permalink, `<base>/archives/<channel>/p<root ts without its dot>`, as `chat.getPermalink` returns it for the root; undefined when a piece is missing. */
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

/** One message's permalink; a reply carries its root and channel as `chat.getPermalink` writes them, so it opens in its thread. */
export function slackMessageUrl(
  workspaceUrl: string | undefined,
  channel: string,
  ts: string,
  threadTs?: string
): string | undefined {
  const url = slackThreadUrl(workspaceUrl, channel, ts)
  if (!url || !threadTs || threadTs === ts) return url
  return `${url}?${new URLSearchParams({ thread_ts: threadTs, cid: channel }).toString()}`
}
