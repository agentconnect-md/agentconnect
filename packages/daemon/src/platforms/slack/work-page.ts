// A channel's Work page as canvas Markdown (assistant-mode.md §5.19).
import type { WorkPage, WorkPageTask } from '../contract.js'

/** The canvas's title: whose work and where, since Slack also lists a canvas outside its channel. */
export function workPageTitle(page: Pick<WorkPage, 'agentName'>, channelName: string | undefined): string {
  return channelName ? `${page.agentName} · #${channelName}` : `${page.agentName}'s work`
}

/** The bookmark's title: inside the channel only whose work it is needs saying. */
export const workBookmarkTitle = (page: Pick<WorkPage, 'agentName'>): string => `${page.agentName}'s work`

// Titles and labels are written by people or the model, so Markdown in them is shown as text.
const plain = (text: string): string => text.replace(/[\\`*_[\]#<>~|]/g, (c) => `\\${c}`)

const minute = (at: number): string => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`

function statusText(task: WorkPageTask): string {
  if (task.status === 'next') return task.nextCheck !== undefined ? `Next check ${minute(task.nextCheck)}` : 'Waiting'
  return task.status === 'running' ? 'Running' : task.status === 'idle' ? 'Idle' : 'Waiting'
}

const KIND_TEXT: Record<WorkPageTask['kind'], string> = {
  task: 'Task',
  'follow-up': 'Follow-up',
  'approved proposal': 'Approved proposal'
}

/** The page's Markdown; `links` maps a thread to its permalink, and a thread without one is not linked. */
export function renderWorkPage(page: WorkPage, links: ReadonlyMap<string, string> = new Map()): string {
  const lines: string[] = []
  // Without it a paused agent's next checks read as overdue work that broke.
  if (page.paused)
    lines.push(
      `**${plain(page.agentName)} is paused.** No task runs and no follow-up is checked until it is resumed in the console.`,
      ''
    )
  lines.push('## Open work', '')
  if (page.tasks.length === 0) lines.push('Nothing is open.')
  for (const task of page.tasks) {
    const title = task.consoleUrl ? `[${plain(task.title)}](${task.consoleUrl})` : plain(task.title)
    const parts = [`**${statusText(task)}**`, KIND_TEXT[task.kind], title]
    const link = task.thread ? links.get(task.thread) : undefined
    if (link) parts.push(`[thread](${link})`)
    lines.push(`- ${parts.join(' · ')}`)
  }
  if (page.more) lines.push('', `And ${page.more} more in the console.`)
  if (page.schedules.length > 0) {
    lines.push('', '## Scheduled', '')
    for (const schedule of page.schedules) {
      const parts = [plain(schedule.label), schedule.nextRun ? `next ${schedule.nextRun}` : 'no run due']
      const link = schedule.thread ? links.get(schedule.thread) : undefined
      if (link) parts.push(`[latest run](${link})`)
      lines.push(`- ${parts.join(' · ')}`)
    }
  }
  const footer = [`Updated ${minute(page.updatedAt)}`]
  if (page.consoleUrl) footer.push(`[Open in the console](${page.consoleUrl})`)
  lines.push('', '---', '', footer.join(' · '))
  return lines.join('\n')
}

/** The threads a page links to, for their permalinks. */
export function workPageThreads(page: WorkPage): string[] {
  return [
    ...new Set(
      [...page.tasks.map((task) => task.thread), ...page.schedules.map((s) => s.thread)].filter(
        (thread): thread is string => !!thread
      )
    )
  ]
}
