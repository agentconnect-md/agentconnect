// What both groups of the Tasks tab share: the group heading and the elapsed-time format.

/** How long a running task has been running: `s`, then `m s`, then `h m`, never negative from a daemon clock ahead of ours. */
export function formatTaskElapsed(startedAt: string, now: number): string {
  const started = new Date(startedAt).getTime()
  if (Number.isNaN(started)) return ''
  const seconds = Math.max(0, Math.round((now - started) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** A group's heading: what it holds, who reports it, and a census of what is on screen. */
export function TaskGroupHeading({ title, hint, census }: { title: string; hint: string; census?: string }) {
  return (
    <div className="flex min-w-0 flex-none items-baseline gap-[6px] px-[2px]">
      <h3 className="m-0 flex-none font-mono text-[10px] font-semibold tracking-[0.08em] text-(--text-tertiary) uppercase">
        {title}
      </h3>
      <span className="min-w-0 flex-1 truncate font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
        {hint}
      </span>
      {census ? (
        <span
          data-tasks-census=""
          className="flex-none font-sans text-[11px] font-normal leading-normal text-(--text-secondary)"
        >
          {census}
        </span>
      ) : null}
    </div>
  )
}
