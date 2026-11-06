'use client'

// A coordinator task's model, effort, approval mode and fast mode, changed from its own thread as the conversation's are from its composer.

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { RuntimeModelSelect } from '@/components/console/RuntimeModelSelect'
import { usePlayground } from '@/components/console/PlaygroundProvider'
import { sessionEffortAfterModelChange, runtimePickerState } from '@/lib/session-runtime-controls'
import { strategyUsesImage } from '@/lib/execution-strategy'
import type { Agent, DaemonRow } from '@/lib/data'

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
  const { getPgSession, pgSetModel, pgSetEffort, pgSetPermissionPreset, pgSetFast } = usePlayground()
  const [selection, setSelection] = useState<Selection>({})
  const session = getPgSession(sessionId)
  // Shown once the task's session has reported what it can change to; until then there is nothing honest to offer.
  if (!session?.availableModels) return null
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
  const choose = (patch: Selection) => setSelection((current) => ({ ...current, ...patch }))
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
