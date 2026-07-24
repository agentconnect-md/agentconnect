const transcriptTime = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit'
})

/** Strip the deterministic uniqueness suffix from daemon transcript timestamps. */
function timestampValue(raw: string | null | undefined): string {
  return (
    raw
      ?.trim()
      .replace(/^local-/, '')
      .split('|', 1)[0] ?? ''
  )
}

export function formatTranscriptTime(raw: string | null | undefined): string {
  const value = timestampValue(raw)
  if (!value) return ''

  const parsed = parseTranscriptTime(value)
  if (parsed == null) return ''
  const date = new Date(parsed)
  // A finite epoch can still be out of Date's ±8.64e15 ms range (e.g. a micro-
  // or nanosecond timestamp), yielding an Invalid Date. Intl.format() throws
  // "Invalid time value" on that, which would crash the whole transcript render.
  if (Number.isNaN(date.getTime())) return ''
  return transcriptTime.format(date)
}

export function parseTranscriptTime(ts: string): number | null {
  const raw = timestampValue(ts)
  if (!raw) return null

  const numeric = Number(raw)
  if (Number.isFinite(numeric)) {
    // Slack timestamps are epoch seconds with a decimal fraction ("1710799200.123456").
    if (raw.includes('.')) return numeric * 1000
    // Daemon-local tool/reasoning/webchat/hook rows use epoch milliseconds.
    return numeric >= 10_000_000_000 ? numeric : numeric * 1000
  }

  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : null
}
