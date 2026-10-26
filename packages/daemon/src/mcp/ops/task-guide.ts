// The `delegateTask` and `messageTask` guides (send-message-guide.md §3.4), shared by `getToolGuide` and the errors that inline them (§3.5).

/** One runnable call: `arguments` is exactly what to pass to `sendMessage`. */
export interface GuideExample {
  use: string
  arguments: Record<string, unknown>
}

/** One task action's guide, in the shape `getToolGuide` returns. */
export interface TaskActionGuide {
  action: 'delegateTask' | 'messageTask'
  purpose: string
  required: string[]
  optional: string[]
  rules: string[]
  examples: GuideExample[]
}

export const DELEGATE_TASK_GUIDE: TaskActionGuide = {
  action: 'delegateTask',
  purpose:
    'Delegate long work of your own to a task of this session that outlives this turn, which people can see and stop.',
  required: ['action', 'message'],
  optional: [],
  rules: [
    'Work you can finish within this turn, even split into parallel parts, goes to your runtime’s own subagent ' +
      'or Task tool instead. Use delegateTask for long work that spans turns, may run a long time, or that people ' +
      'should be able to see and stop ("fix this bug and open a PR"). Quick lookups and status checks stay in ' +
      'this turn.',
    'Before delegating work that changes a live environment (deploys, upgrades, infrastructure, data), confirm it ' +
      'with the person in this conversation first. A casual follow-up such as "check again" is not approval to run ' +
      'such work.',
    'Delegate it before exploring the request yourself, say it has started, end your turn, and do not do the work ' +
      'here too. Questions, lookups and short answers never need a task.',
    'A task works in the background in a context of its own that starts from this session’s context. It posts ' +
      'nothing and has no conversation: its progress, questions and results come back to this session, which ' +
      'speaks for it.',
    'It reports back into this session automatically each time a round of its work finishes or fails — no ' +
      'needsReply needed. It can also send you progress or a question meanwhile; answer with messageTask and its ' +
      '`taskId`.',
    'Order tasks by what they need: start independent tasks together, and start a task that needs another’s ' +
      'result only once that result has arrived.',
    'Say in its message which language the people here use, so it reports in that language.',
    'Only `action` and `message` are accepted; the daemon derives you from trusted context.',
    'A task cannot start tasks of its own, and only a few run at once. Refusals arrive as `wake.delivered: false` ' +
      'with a `wake.reason` and `wake.message`: `task_nesting` (this session is itself a task) and `task_limit` ' +
      '(too many tasks running at once; a finished task holds no slot).',
    'The result carries `taskId`, the handle messageTask, viewSessionStatus and stopTask take; listTasks shows ' +
      'every task of this session with it. It is not a message id for replyToSession or a session id for callAgent.',
    'To work visibly as yourself in a channel instead, use callAgent with your own id and `channel`: that is a ' +
      'conversation, not a task.'
  ],
  examples: [
    {
      use: 'Delegate a task',
      arguments: {
        action: 'delegateTask',
        message: 'Investigate the flaky test in the background and report your findings.'
      }
    }
  ]
}

export const MESSAGE_TASK_GUIDE: TaskActionGuide = {
  action: 'messageTask',
  purpose: 'Send more work or an answer to a task this session started.',
  required: ['action', 'taskId', 'message'],
  optional: [],
  rules: [
    '`taskId` is the `taskId` a delegateTask call in this session returned, or one listTasks or your reminders ' +
      'show. A missing, null or empty `taskId` is refused and never starts a task; use delegateTask for new work.',
    'The message reaches that task, which keeps its context, whether it is still running or already reported. A ' +
      'message to a task that is still working waits for its next turn and does not interrupt it; one that already ' +
      'finished starts a new round of work in the same context, which reports back again.',
    'Only the session that started a task can message it. Not accepted: `toAgent`, `channel`, `thread`, ' +
      '`platform`, `integrationId`, `attachment`, `sessionId`, `messageId`, `needsReply`.',
    'Refusals arrive as `wake.delivered: false` with a `wake.reason` and `wake.message`: `task_not_found` (this ' +
      'session started no task with that id), `task_reporting` (its previous report is still on its way; message ' +
      'it again after it arrives), and `task_limit`.',
    'stopTask {"taskId":"<taskId>"} stops a task of this session when it is no longer needed: the plan changed, a ' +
      'task it depended on failed, or its result is not wanted any more. What it already did is not undone, and a ' +
      'later messageTask can give it new work.'
  ],
  examples: [
    {
      use: 'More work for a task you started, running or finished',
      arguments: {
        action: 'messageTask',
        taskId: '<taskId returned by delegateTask>',
        message: 'Continue with the Windows failure and keep your earlier findings.'
      }
    }
  ]
}

/** The `delegateTask` guide as plain text, for an error that hands it over inline. */
export const DELEGATE_TASK_GUIDE_TEXT = [
  DELEGATE_TASK_GUIDE.purpose,
  ...DELEGATE_TASK_GUIDE.rules.map((rule) => `- ${rule}`),
  `Example: sendMessage ${JSON.stringify(DELEGATE_TASK_GUIDE.examples[0]!.arguments)}`
].join('\n')
