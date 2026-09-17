'use client'

import { useEffect, useState } from 'react'
import {
  AGENT_SETUP_URI,
  CODE_HOST_SETUP_URI,
  INTEGRATION_SETUP_URI,
  MCP_SETUP_URI,
  SKILL_SETUP_URI,
  type NativeMcpUi
} from '@agentconnect.md/protocol/mcp-app'
import { isCodeHostProvider } from '@agentconnect.md/protocol/code-host'
import { Button } from '@/components/ui'
import { useOrgs } from '@/lib/org-context'
import { useConsoleData } from '@/lib/data-context'
import {
  fetchAgentHooks,
  fetchAgentRepos,
  fetchGithubInstallations,
  updateGithubHook,
  updateGitlabHook,
  updateGiteaHook,
  updateIntegrationChannel,
  type HookDto,
  type AgentRepoAuthDto,
  type GithubInstallationDto
} from '@/lib/api'
import { GithubReviewSettings } from '../GithubReviewSettings'
import { GitlabReviewSettings } from '../GitlabReviewSettings'
import { GiteaReviewSettings } from '../GiteaReviewSettings'
import { channelListSemantics } from '../platforms/registry'
import {
  effectiveRepoAccess,
  installationForRepo,
  requiredRepoAccess,
  repoAccessSatisfies,
  hasChecksWritePermission,
  hasPullRequestsReadPermission,
  hasPullRequestsWritePermission,
  type HookReviewPolicy,
  type HookReportingMode
} from '@/lib/github-review-settings'
import type { IntegrationRow } from '@/lib/data'
import {
  triggerModeOf,
  githubCommentFamilies,
  githubFamilySubscription,
  type GhFamily,
  type GhTriggerMode
} from '@/lib/github-events'
import {
  gitlabTriggerModeOf,
  gitlabCommentFamilies,
  gitlabFamilySubscription,
  type GlFamily,
  type GlTriggerMode
} from '@/lib/gitlab-events'
import {
  giteaTriggerModeOf,
  giteaCommentFamilies,
  giteaFamilySubscription,
  type GtFamily,
  type GtTriggerMode
} from '@/lib/gitea-events'
import { AddIntegrationForOrgModal } from './AddIntegrationModal'
import CodeHostSetupDialog from './CodeHostSetupDialog'
import AgentSetupDialog from './AgentSetupDialog'
import SkillSetupDialog from './SkillSetupDialog'
import McpSetupDialog from './McpSetupDialog'
import { NativeDialogNotice } from './NativeDialogNotice'

interface Props {
  ui: Extract<NativeMcpUi, { resourceUri: typeof INTEGRATION_SETUP_URI }>
  onClose: () => void
  onCompleted: (summary: string) => void
}

/** One presentation intent, one dialog: the `ui://` resource the tool named picks which. */
export default function NativeIntegrationDialog({
  ui,
  onClose,
  onCompleted
}: {
  ui: NativeMcpUi
  onClose: () => void
  onCompleted: (summary: string) => void
}) {
  const props = { onClose, onCompleted }
  switch (ui.resourceUri) {
    case CODE_HOST_SETUP_URI:
      return <CodeHostSetupDialog ui={ui} {...props} />
    case AGENT_SETUP_URI:
      return <AgentSetupDialog ui={ui} {...props} />
    case SKILL_SETUP_URI:
      return <SkillSetupDialog ui={ui} {...props} />
    case MCP_SETUP_URI:
      return <McpSetupDialog ui={ui} {...props} />
    default:
      return <IntegrationSetupDialog ui={ui} {...props} />
  }
}

function IntegrationSetupDialog({ ui, onClose, onCompleted }: Props) {
  const { activeOrg } = useOrgs()
  const { agents, integrations, loading } = useConsoleData()
  const intent = ui.intent
  const agent = agents.find((item) => item.id === intent.agentId)
  const notice = (text: string) => (
    <NativeDialogNotice heading="Integration configuration" text={text} onClose={onClose} />
  )
  if (activeOrg?.id !== ui.orgId) return notice('This configuration belongs to another organization.')
  if (loading) return notice('Loading configuration…')
  if (intent.agentId && !agent?.canEdit) return notice("You cannot edit this agent's integrations.")
  if (intent.mode === 'create')
    return (
      <AddIntegrationForOrgModal
        initialPlatform={intent.provider}
        initialAgentId={intent.agentId}
        onClose={onClose}
        onCompleted={onCompleted}
      />
    )
  if (intent.target.kind === 'codehost-subscription')
    return <EditSubscription key={intent.target.id} {...{ ui, onClose, onCompleted }} />
  const integration = integrations.find((item) => item.id === intent.target.id && item.agentId === intent.agentId)
  return integration ? (
    <EditChannels
      key={integration.id}
      integration={integration}
      orgId={ui.orgId}
      onClose={onClose}
      onCompleted={onCompleted}
    />
  ) : (
    notice('This integration is unavailable.')
  )
}

function EditChannels({
  integration,
  orgId,
  onClose,
  onCompleted
}: {
  integration: IntegrationRow
  orgId: string
  onClose: () => void
  onCompleted: (summary: string) => void
}) {
  const { refresh } = useConsoleData()
  const allowed = channelListSemantics(integration.platform).triggers
  const [draft, setDraft] = useState(() =>
    Object.fromEntries(integration.channels.map((row) => [row.channelId, row.trigger]))
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      for (const row of integration.channels) {
        if (draft[row.channelId] !== row.trigger)
          await updateIntegrationChannel(integration.id!, row.channelId, { trigger: draft[row.channelId] }, orgId)
      }
      await refresh()
      onCompleted(`Updated conversation triggers for ${integration.name}.`)
      onClose()
    } catch (e) {
      setError(`Some changes may already be saved. ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div className="modalhead">Edit {integration.name}</div>
      <div className="modalbody flex flex-col gap-3">
        <p className="text-[13px] text-(--text-secondary)">
          Choose when the agent responds in each conversation. Saving updates routing for this integration.
        </p>
        {integration.channels.map((row) => (
          <label key={row.channelId} className="flex items-center justify-between gap-3">
            {row.name}
            <select
              className="inp"
              value={draft[row.channelId]}
              disabled={busy}
              onChange={(e) => setDraft({ ...draft, [row.channelId]: e.target.value as 'off' | 'mention' | 'any' })}
            >
              <option value="off">Off</option>
              {row.kind !== 'im' && (!allowed || allowed.includes('mention')) && (
                <option value="mention">When mentioned</option>
              )}
              {(row.kind === 'im' || !allowed || allowed.includes('any')) && <option value="any">Every message</option>}
            </select>
          </label>
        ))}
        {!integration.channels.length && <p>No conversations are available yet.</p>}
        {error && <p role="alert">{error}</p>}
      </div>
      <div className="modalfoot">
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={busy || !integration.channels.length} onClick={() => void save()}>
          Save changes
        </Button>
      </div>
    </>
  )
}

function EditSubscription({ ui, onClose, onCompleted }: Props) {
  const intent = ui.intent
  const [hook, setHook] = useState<HookDto | null>(null)
  const [name, setName] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [mode, setMode] = useState<GhTriggerMode>('first')
  const [modeChanged, setModeChanged] = useState(false)
  const [reviewPolicy, setReviewPolicy] = useState<HookReviewPolicy>('off')
  const [reportingMode, setReportingMode] = useState<HookReportingMode>('off')
  const [repos, setRepos] = useState<AgentRepoAuthDto[]>([])
  const [installations, setInstallations] = useState<GithubInstallationDto[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const { refresh, agents } = useConsoleData()
  const repoAccess = effectiveRepoAccess({
    repoId: hook?.repoId,
    repoFullName: hook?.repoFullName,
    workspace: agents.find((agent) => agent.id === intent.agentId)?.workspace ?? { mode: 'scratch' },
    authorizations: repos
  })
  const installation = installationForRepo(hook?.repoFullName, installations)
  const reviewChanged = !!hook && (reviewPolicy !== hook.reviewPolicy || reportingMode !== hook.reportingMode)
  const reviewBlocked =
    hook?.kind === 'github' &&
    reviewChanged &&
    (!repoAccessSatisfies(repoAccess, requiredRepoAccess({ reviewPolicy, reportingMode })) ||
      (reviewPolicy !== 'off' && !hasPullRequestsWritePermission(installation)) ||
      (reportingMode === 'check' &&
        (!hasChecksWritePermission(installation) || !hasPullRequestsReadPermission(installation))))
  useEffect(() => {
    if (intent.mode !== 'edit') return
    let alive = true
    void fetchAgentHooks(intent.agentId, ui.orgId)
      .then((rows) => {
        if (!alive) return
        const found = rows.find((row) => row.id === intent.target.id && row.agentId === intent.agentId)
        if (!found || !isCodeHostProvider(found.kind)) {
          setError('This subscription is unavailable.')
          return
        }
        setHook(found)
        setName(found.name)
        setEnabled(found.enabled)
        setReviewPolicy(found.reviewPolicy)
        setReportingMode(found.reportingMode)
        if (found.kind === 'github') {
          void Promise.all([fetchAgentRepos(intent.agentId, ui.orgId), fetchGithubInstallations(ui.orgId)])
            .then(([authorizations, installed]) => {
              if (alive) {
                setRepos(authorizations)
                setInstallations(installed.installations)
              }
            })
            .catch(() => {
              if (alive)
                setError('Repository permissions could not be loaded. Reopen the dialog to change review settings.')
            })
        }
        setMode(
          found.kind === 'github'
            ? triggerModeOf(found)
            : found.kind === 'gitlab'
              ? gitlabTriggerModeOf(found)
              : giteaTriggerModeOf(found)
        )
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
  }, [intent, ui.orgId])
  const save = async () => {
    if (busy || !hook || intent.mode !== 'edit' || reviewBlocked) return
    setBusy(true)
    setError('')
    try {
      const latest = (await fetchAgentHooks(intent.agentId, ui.orgId)).find((row) => row.id === hook.id)
      if (!latest || latest.configRevision !== hook.configRevision)
        throw new Error('This subscription changed. Close and reopen the dialog before saving.')
      const common = {
        agentId: intent.agentId,
        name: name.trim(),
        enabled,
        reviewPolicy,
        reportingMode
      }
      if (hook.kind === 'github')
        await updateGithubHook(
          hook.id,
          {
            ...common,
            repoFullName: hook.repoFullName!,
            ...(modeChanged
              ? githubFamilySubscription(hook.family as GhFamily, mode)
              : {
                  events: hook.events,
                  mentionOnly: hook.mentionOnly,
                  commentFamilies: githubCommentFamilies(hook.commentFamilies)
                }),
            labelFilter: hook.labelFilter,
            gateMode: 'informational'
          },
          ui.orgId
        )
      else if (hook.kind === 'gitlab')
        await updateGitlabHook(
          hook.id,
          {
            ...common,
            projectId: hook.repoId!,
            ...(modeChanged
              ? gitlabFamilySubscription(hook.family as GlFamily, mode as GlTriggerMode)
              : {
                  events: hook.events,
                  mentionOnly: hook.mentionOnly,
                  commentFamilies: gitlabCommentFamilies(hook.commentFamilies)
                })
          },
          ui.orgId
        )
      else
        await updateGiteaHook(
          hook.id,
          {
            ...common,
            repoId: hook.repoId!,
            ...(modeChanged
              ? giteaFamilySubscription(hook.family as GtFamily, mode as GtTriggerMode)
              : {
                  events: hook.events,
                  mentionOnly: hook.mentionOnly,
                  commentFamilies: giteaCommentFamilies(hook.commentFamilies)
                })
          },
          ui.orgId
        )
      await refresh()
      onCompleted(`Updated ${hook.kind} subscription ${name.trim()} for ${hook.repoFullName ?? hook.repoId}.`)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div className="modalhead">Edit integration</div>
      <div className="modalbody flex flex-col gap-3">
        {hook ? (
          <>
            <p>
              {hook.repoFullName ?? hook.repoId} · {hook.family}
            </p>
            <label>
              Name
              <input
                className="inp"
                value={name}
                disabled={busy}
                maxLength={120}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              <input type="checkbox" checked={enabled} disabled={busy} onChange={(e) => setEnabled(e.target.checked)} />{' '}
              Enabled
            </label>
            <label>
              Trigger
              <select
                className="inp"
                value={mode}
                disabled={busy}
                onChange={(e) => {
                  setMode(e.target.value as GhTriggerMode)
                  setModeChanged(true)
                }}
              >
                <option value="first">When created</option>
                <option value="every">Every update</option>
                <option value="mention">When mentioned</option>
                {hook.kind === 'github' && hook.family === 'issues' && <option value="labeled">When labeled</option>}
              </select>
            </label>
            <p className="text-[13px] text-(--text-secondary)">
              Saving changes which repository events start an agent session.
            </p>
            {(hook.family === 'pull_request' || hook.family === 'merge_request') && (
              <fieldset disabled={busy}>
                {hook.kind === 'github' ? (
                  <GithubReviewSettings
                    value={{ reviewPolicy, reportingMode }}
                    onReviewPolicyChange={setReviewPolicy}
                    onReportingModeChange={setReportingMode}
                    repoAccess={repoAccess}
                    installation={installation}
                    defaultExpanded
                  />
                ) : hook.kind === 'gitlab' ? (
                  <GitlabReviewSettings
                    value={{ reviewPolicy, reportingMode }}
                    onReviewPolicyChange={setReviewPolicy}
                    onReportingModeChange={setReportingMode}
                    defaultExpanded
                  />
                ) : (
                  <GiteaReviewSettings
                    value={{ reviewPolicy, reportingMode }}
                    onReviewPolicyChange={setReviewPolicy}
                    onReportingModeChange={setReportingMode}
                    defaultExpanded
                  />
                )}
              </fieldset>
            )}
          </>
        ) : (
          !error && <p>Loading configuration…</p>
        )}
        {error && <p role="alert">{error}</p>}
      </div>
      <div className="modalfoot">
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={!hook || busy || !name.trim() || reviewBlocked} onClick={() => void save()}>
          Save changes
        </Button>
      </div>
    </>
  )
}
