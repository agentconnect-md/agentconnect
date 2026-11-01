// A closed task keeps its row for one window (assistant-mode.md §5.18 ④): readTask still finds it, the board and listTasks do not.

/** How long a closed task's record is kept: 90 days, the default `sessions.retention`, the tier that keeps session rows and transcripts. */
export const CLOSED_TASK_RETENTION_MS = 90 * 24 * 60 * 60_000

/** The one close of a task in work or watch mode: when it closed, stamped once; binds the time. */
export const CLOSE_TASK = 'closedAt = COALESCE(closedAt, ?)'

/** The clock of a row kept beside a task: its task's close, or zero once no row of that task is left. */
export const taskClosedClock = (table: string): string =>
  `COALESCE((SELECT a.closedAt FROM assistant_subsession a
      WHERE a.agentId = ${table}.agentId AND a.childSessionKey = ${table}.taskKey), 0)`

/** A row kept beside a task that is no longer open: closed, or gone. */
export const noOpenTask = (table: string): string =>
  `NOT EXISTS (SELECT 1 FROM assistant_subsession a
      WHERE a.agentId = ${table}.agentId AND a.childSessionKey = ${table}.taskKey AND a.closedAt IS NULL)`
