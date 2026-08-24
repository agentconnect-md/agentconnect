import {
  agentActivate,
  agentDetach,
  agentLaunch,
  agentPermissionDecision,
  agentPermissionRequests,
  agentRemove,
  agentStop,
  agentUpsert,
  agentWake,
  type AgentControlDeps
} from './agent.js'
import { codeHostNoteDesired, type CodeHostControlDeps } from './codehost.js'
import { configPush, type ConfigApplyDeps } from './config.js'
import type { ControlHandler } from './context.js'
import { cronRemove, cronRun, cronUpsert } from './cron.js'
import { daemonDrain, daemonRestart, daemonUpgrade, type DaemonOpsDeps } from './daemon-ops.js'
import {
  dreamAdopt,
  dreamCancel,
  dreamDiscard,
  dreamFileRead,
  dreamFiles,
  dreamGet,
  dreamList,
  dreamSkillAccept,
  dreamSkillDismiss,
  dreamSkillRead,
  dreamStart,
  knowledgeSuggestionRead,
  knowledgeSuggestionReview,
  type DreamControlDeps
} from './dream.js'
import { dutyGrant, dutyRenewed, dutyRevoke, type DutyControlDeps } from './duty.js'
import { integrationForget, integrationLeave, integrationRemove, integrationUpsert } from './integration.js'
import { mcpServerRemove, mcpServerUpsert } from './mcpserver.js'
import {
  memoryChannels,
  memoryHistory,
  memoryList,
  memoryRead,
  memoryRecordCreate,
  memoryRecordDelete,
  memoryRecordGet,
  memoryRecordHistory,
  memoryRecordList,
  memoryRecordSearch,
  memoryRecordUpdate,
  memorySurface,
  memoryWrite,
  type MemoryControlDeps
} from './memory.js'
import { memoryConnectionRemove, memoryConnectionUpsert } from './memoryconnection.js'
import { collaborationRoutes, relayRoster, routeAssign, routeUpdate } from './route.js'
import {
  sessionChildStatusProbe,
  sessionHistory,
  sessionList,
  sessionToolBody,
  sessionVisibility,
  sessionVisibilitySnapshot,
  type SessionControlDeps
} from './session.js'
import { runtimeCommands, skillsLocal, type SkillsControlDeps } from './skills.js'
import { taskList, type TaskControlDeps } from './task.js'
import { autoMergeSet, autoMergeState, type AutoMergeControlDeps } from './automerge.js'
import { sandboxKeepAlive, type SandboxKeepAliveDeps } from './sandbox-keepalive.js'
import {
  workspaceDelete,
  workspaceGitCommit,
  workspaceGitDiff,
  workspaceGitLog,
  workspaceGitMessage,
  workspaceGitPull,
  workspaceGitPush,
  workspaceGitStage,
  workspaceGitStatus,
  workspaceGitUnstage,
  workspaceList,
  workspaceRead,
  workspaceWrite,
  type WorkspaceControlDeps
} from './workspace.js'

/**
 * Everything the C→D control handlers need, composed from the per-domain deps each
 * group declares (`src/cp/control/*`). One flat object still satisfies it, so the client
 * assembles it as a single literal; the grouping is what lets a handler take only the
 * slice it uses. The client-owned members (duty deadlines, the drain edge, the commit-message
 * join table) are the ones no CP dep can supply — everything else comes from `CpClientDeps`.
 */
export interface ControlDeps
  extends
    AgentControlDeps,
    CodeHostControlDeps,
    ConfigApplyDeps,
    DaemonOpsDeps,
    DreamControlDeps,
    DutyControlDeps,
    MemoryControlDeps,
    SessionControlDeps,
    SkillsControlDeps,
    TaskControlDeps,
    AutoMergeControlDeps,
    SandboxKeepAliveDeps,
    WorkspaceControlDeps {}

/** Every dispatchable C→D control frame kind, by wire type. A type absent here is ignored. */
export const CONTROL_HANDLERS: Map<string, ControlHandler<ControlDeps>> = new Map<string, ControlHandler<ControlDeps>>([
  ['config/push', configPush],
  ['duty/grant', dutyGrant],
  ['duty/renewed', dutyRenewed],
  ['duty/revoke', dutyRevoke],
  ['cron/upsert', cronUpsert],
  ['cron/remove', cronRemove],
  ['cron/run', cronRun],
  ['session/visibility', sessionVisibility],
  ['session/visibility/snapshot', sessionVisibilitySnapshot],
  ['route/assign', routeAssign],
  ['route/update', routeUpdate],
  ['relay/roster', relayRoster],
  ['collaboration/routes', collaborationRoutes],
  ['agent/upsert', agentUpsert],
  ['agent/remove', agentRemove],
  ['agent/detach', agentDetach],
  ['agent/activate', agentActivate],
  ['agent/permission-requests', agentPermissionRequests],
  ['agent/permission-decision', agentPermissionDecision],
  ['integration/upsert', integrationUpsert],
  ['integration/remove', integrationRemove],
  ['integration/forget', integrationForget],
  ['integration/leave', integrationLeave],
  ['mcpserver/upsert', mcpServerUpsert],
  ['mcpserver/remove', mcpServerRemove],
  ['memoryconnection/upsert', memoryConnectionUpsert],
  ['memoryconnection/remove', memoryConnectionRemove],
  ['agent/launch', agentLaunch],
  ['agent/stop', agentStop],
  ['daemon/drain', daemonDrain],
  ['daemon/restart', daemonRestart],
  ['daemon/upgrade', daemonUpgrade],
  ['session/list', sessionList],
  ['session/history', sessionHistory],
  ['session/child-status/probe', sessionChildStatusProbe],
  ['session/tool-body', sessionToolBody],
  ['workspace/list', workspaceList],
  ['workspace/read', workspaceRead],
  ['workspace/write', workspaceWrite],
  ['workspace/delete', workspaceDelete],
  ['workspace/gitstatus', workspaceGitStatus],
  ['workspace/gitdiff', workspaceGitDiff],
  ['workspace/gitlog', workspaceGitLog],
  ['workspace/gitpull', workspaceGitPull],
  ['workspace/gitstage', workspaceGitStage],
  ['workspace/gitunstage', workspaceGitUnstage],
  ['workspace/gitcommit', workspaceGitCommit],
  ['workspace/gitpush', workspaceGitPush],
  ['workspace/gitmessage', workspaceGitMessage],
  ['task/list', taskList],
  ['automerge/set', autoMergeSet],
  ['automerge/state', autoMergeState],
  ['sandbox/keepalive', sandboxKeepAlive],
  ['agent/wake', agentWake],
  ['memory/channels', memoryChannels],
  ['memory/list', memoryList],
  ['memory/read', memoryRead],
  ['memory/write', memoryWrite],
  ['memory/history', memoryHistory],
  ['memory/surface', memorySurface],
  ['memory/record/search', memoryRecordSearch],
  ['memory/record/list', memoryRecordList],
  ['memory/record/get', memoryRecordGet],
  ['memory/record/create', memoryRecordCreate],
  ['memory/record/update', memoryRecordUpdate],
  ['memory/record/delete', memoryRecordDelete],
  ['memory/record/history', memoryRecordHistory],
  ['memory/dream/start', dreamStart],
  ['memory/dream/cancel', dreamCancel],
  ['memory/dream/list', dreamList],
  ['memory/dream/get', dreamGet],
  ['memory/dream/adopt', dreamAdopt],
  ['memory/dream/discard', dreamDiscard],
  ['memory/dream/files', dreamFiles],
  ['memory/dream/file/read', dreamFileRead],
  ['memory/dream/skill/read', dreamSkillRead],
  ['memory/dream/skill/accept', dreamSkillAccept],
  ['memory/dream/skill/dismiss', dreamSkillDismiss],
  ['skills/local', skillsLocal],
  ['runtime/commands', runtimeCommands],
  ['knowledge/suggestion/read', knowledgeSuggestionRead],
  ['knowledge/suggestion/review', knowledgeSuggestionReview],
  ['codehost/note-desired', codeHostNoteDesired]
])
