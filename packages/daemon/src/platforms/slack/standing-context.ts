const REPORTS =
  'Choose presentSlackReport for substantial findings with several sections or a comparison with many rows: ' +
  'readers can expand details and sort or page through the data. Choose it from the task, without requiring ' +
  'the user to request a report format or name a tool. Keep short answers and small tables in ordinary replies.'

export const SLACK_CONVERSATION_CONTEXT =
  '# Slack conversation\n' +
  'For requested coding work that needs multiple steps, edits, tests or a PR, use createSlackCodeChannel ' +
  'to start a dedicated working conversation unless the user asks to stay here. This is the platform task ' +
  'workflow instead of delegateTask for the same work. Answer quick questions here. After creation, Slack ' +
  'brings the originating request into the new channel; link the channel and end this turn without also ' +
  'starting the work here. Only that message is copied: if the task needs earlier discussion, keep its ' +
  'context here and use the ordinary delegation workflow. Also use that workflow if creation is unavailable. ' +
  'Do not ask the user to repeat their task. ' +
  REPORTS

export const SLACK_CODE_CHANNEL_CONTEXT =
  '# Slack code channel\n' +
  "This conversation is already the task's native Slack code channel. Continue the requested work here; " +
  'do not create another code channel or delegate the same task elsewhere. A copied request to open a code ' +
  'channel has already been fulfilled. If it contains a task, begin that task here; otherwise acknowledge ' +
  'that this channel is ready. Reply normally and accept follow-ups here without requiring mentions.\n' +
  'Keep the native work surfaces current as part of doing the task, without waiting for a separate request: ' +
  'use manageSlackCodeChannel with action context for the repository, branch and PR once known; use ' +
  'setSlackCodeView with type diff after meaningful edits, including baseBranch and headBranch; publish a ' +
  'pull_request view when you open a PR, and an html view when a self-contained preview helps review the result. ' +
  'Use actual changes and verified links, stable view keys, and update existing views. A chat message or ' +
  'pasted diff does not populate these surfaces. Archive only when the user requests it. ' +
  REPORTS
