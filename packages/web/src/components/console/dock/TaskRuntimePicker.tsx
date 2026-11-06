'use client'

// A coordinator task's model, effort, approval mode and fast mode, changed from its own thread as the conversation's are from its composer.

import { useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { RuntimeModelSelect } from '@/components/console/RuntimeModelSelect'
import { usePlayground } from '@/components/console/PlaygroundProvider'
import { sessionEffortAfterModelChange, runtimePickerState } from '@/lib/session-runtime-controls'
import { strategyUsesImage } from '@/lib/execution-strategy'
import type { Agent, DaemonRow, Session } from '@/lib/data'
import { fetchSessionDetail, type SessionDetailDto } from '@/lib/api'
import { CONSOLE_SWR_CONFIG, readOnceRegistered } from '@/lib/console-swr'

type Selection = { model?: string; effort?: string; permissionPreset?: string; fast?: boolean }

export function TaskRuntimePicker({
  sessionId,
  agentId,
  owner,
  owningDaemon,
  agentRuntime,
  editable
}: {
  /** The task's own session, whose live settings the picker reads and changes. */
  sessionId: string
  agentId: string
  owner: Agent | undefined
  owningDaemon: DaemonRow | undefined
  agentRuntime: string
  /** The reader may change settings from chat; otherwise the picker only names them. */
  editable: boolean
}) {
  const t = useTranslations('Sessions.detail')
  const permissionT = useTranslations('Common.permissionModes')
  const { getPgSession, markSessionTarget, pgSetModel, pgSetEffort, pgSetPermissionPreset, pgSetFast } = usePlayground()
  const [selection, setSelection] = useState<Selection>({})
  // The same read the thread makes: the task's recorded runtime, until its live session reports its own.
  const { data: detail } = useSWR(
    ['session-detail', sessionId],
    ([, sid]) => readOnceRegistered(() => fetchSessionDetail(sid)),
    CONSOLE_SWR_CONFIG
  )
  const session = getPgSession(sessionId) ?? (detail ? recordedRuntime(detail) : undefined)
  if (!session) return null
  const runtime = session.runtime ?? agentRuntime
  const state = runtimePickerState({
    session,
    selection,
    owner,
    owningDaemon,
    agentRuntime: runtime,
    beforeFirstTurn: false,
    runtimeUnresolved: session.runtimePending === true,
    permissionT
  })
  // A change goes to the task's own session, so the target is marked before any is sent.
  const choose = (patch: Selection) => {
    markSessionTarget(sessionId)
    setSelection((current) => ({ ...current, ...patch }))
  }
  return (
    <span data-task-runtime="" className="flex min-w-0 flex-none">
      <RuntimeModelSelect
        compact
        ariaLabel={t('model')}
        value={{ runtime, model: state.pgShownModel }}
        source={state.pickerSource}
        runtimes={[runtime]}
        readsImage={!!owner && strategyUsesImage(owner.execution)}
        readOnly={!editable}
        settings={{
          effort: state.pgEffort
            ? {
                value: state.pgEffort,
                options: state.pgEffortOptions,
                onChange: (effort) => {
                  choose({ effort })
                  pgSetEffort(sessionId, agentId, effort)
                }
              }
            : undefined,
          approval: state.pgPermissionPreset
            ? {
                value: state.pgPermissionPreset,
                options: state.pgApprovalOptions,
                onChange: (permissionPreset) => {
                  choose({ permissionPreset })
                  pgSetPermissionPreset(sessionId, agentId, permissionPreset)
                }
              }
            : undefined,
          fast: state.pgFastModeAvailable
            ? {
                value: state.pgFastMode,
                onChange: (fast) => {
                  choose({ fast })
                  pgSetFast(sessionId, agentId, fast)
                }
              }
            : undefined
        }}
        onChange={(target) => {
          const currentEffort = selection.effort ?? session.effort ?? owner?.reasoning ?? ''
          const effort = sessionEffortAfterModelChange(target.runtime, owningDaemon, target.model, currentEffort)
          choose({ model: target.model, effort })
          pgSetModel(sessionId, agentId, target.model)
          if (effort !== currentEffort) pgSetEffort(sessionId, agentId, effort)
        }}
      />
    </span>
  )
}

/** What the task's record says it runs, in the shape the picker reads; the choices come from the agent's catalogs. */
function recordedRuntime(detail: SessionDetailDto): Partial<Session> {
  return {
    ...(detail.runtime ? { runtime: detail.runtime } : {}),
    ...(detail.model ? { model: detail.model } : {}),
    ...(detail.effort ? { effort: detail.effort } : {}),
    ...(detail.permissionMode ? { permissionMode: detail.permissionMode } : {}),
    ...(detail.fastMode !== null ? { fastMode: detail.fastMode } : {})
  }
}
