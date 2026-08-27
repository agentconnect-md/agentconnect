// No 'use client' here: rendered only by ModalProvider (the client boundary).

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  approvalsReviewerDefault,
  effortChoicesFor,
  effortField,
  effortLabel,
  FALLBACK_RUNTIME_IDS,
  loginRequiredRuntimeIds,
  fastModeAvailableFor,
  modelCapability,
  modelLabel,
  displayedEffort,
  preferredModelFor,
  resolveEffortForModel,
  permissionModeChoicesFor,
  permissionModeDefault,
  permissionModeLabel,
  permissionModePresets,
  permissionPresetSettings,
  runtimeLabel,
  selectedPermissionPreset,
  supportsModes,
  agentLabel,
  poolLabel,
  poolTagline,
  POOL_PLACEMENT,
  groupPlacementValue,
  groupSetIdOf,
  type MemberSetRow,
  placementValueOf,
  type Agent,
  type AgentCallPolicy,
  type ApprovalsReviewer
} from '@/lib/data'
import { acpRuntime, useAcpRegistry } from '@/lib/acp-registry'
import { fetchAgentDto, type AgentCallPolicyInput, type UpdateAgentInput } from '@/lib/api'
import { useConsoleData } from '@/lib/data-context'
import { featureFlagEnabled } from '@/lib/feature-flags'
import { useOrgs } from '@/lib/org-context'
import { buildAgentReachabilityGraph } from '@/lib/agent-reachability'
import { Spinner } from '@/components/marks'
import { Button, Icon, Toggle } from '@/components/ui'
import { DaemonSelect, type DaemonSelectOption } from '@/components/console/DaemonSelect'
import { useModal } from '@/components/console/ModalProvider'
import { RuntimeSelect } from '@/components/console/RuntimeSelect'
import { editAgentCapabilitySource, editAgentDaemonChoices, preselectPlacementReset } from './edit-agent-daemon-choice'
import { VisibilityField, sameSharing, type SharingValue } from '@/components/console/VisibilityField'
import { AgentCallVisibility } from '@/components/console/AgentCallVisibility'
import {
  EnvSecretsFields,
  envRecordFromRows,
  envRowsFromEnv,
  envSecretsError,
  secretRowsFromKeys,
  secretsPatchFromRows,
  type EnvVarDraft,
  type SecretDraft
} from '@/components/console/EnvSecretsFields'
import { OutputModeField } from '@/components/console/OutputModeField'
import { RuntimeChatField } from '@/components/console/RuntimeChatField'
import { SandboxField } from '@/components/console/SandboxField'
import { isOutputMode, type OutputMode } from '@/lib/output-mode'

// The edit dialog mirrors the Add-agent modal: a single scrolling form with a
// section rail beside it. Every group card on the Configuration page opens this
// modal at the matching anchor (basics / runtime behavior / access), so the two
// edit surfaces stay identical. Workspace and Memory keep their own dedicated
// editors (the Workspace card / the Memory tab), so they are NOT sections here.
export type EditAgentSection = 'basics' | 'runtime' | 'access' | 'secrets'

// A picker row that opens the join-command dialog instead of naming a placement. Never a
// daemonId, so it can never be saved: the onChange below intercepts it.
const ADD_DAEMON = '__add_daemon__'

const SECTIONS: ReadonlyArray<{ id: EditAgentSection; label: string; icon: string }> = [
  { id: 'basics', label: 'Basics', icon: 'id-card' },
  { id: 'runtime', label: 'Runtime', icon: 'sliders-horizontal' },
  { id: 'access', label: 'Access', icon: 'lock' },
  { id: 'secrets', label: 'Variables and Secrets', icon: 'code-xml' }
]

const RAIL_ITEM_ON =
  'flex flex-none cursor-pointer items-center gap-[9px] rounded-sm border-0 bg-(--surface-card) px-[10px] py-[7px] text-left font-sans text-[12.5px] font-semibold leading-normal text-(--text-primary) shadow-(--shadow-xs)'
const RAIL_ITEM_OFF =
  'flex flex-none cursor-pointer items-center gap-[9px] rounded-sm border-0 bg-transparent px-[10px] py-[7px] text-left font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary) hover:bg-(--surface-hover)'

// Set-equality for the agent-call allow-lists (order-insensitive).
function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id))
}

// Drop self-references and duplicates before persisting an allow-list.
function normalizeSelected(subjectAgentId: string, ids: string[]): string[] {
  return [...new Set(ids)].filter((id) => id !== subjectAgentId)
}

export default function EditAgentModal({
  agent,
  focusSection,
  preselectDaemonId,
  onClose
}: {
  agent: Agent
  focusSection?: EditAgentSection
  /** A daemon to open the placement picker on — set when a chained Add-daemon dialog just
   *  connected one, so Continue lands on a form already pointed at the new machine. */
  preselectDaemonId?: string
  onClose: () => void
}) {
  const acpRegistry = useAcpRegistry()
  const {
    updateAgent,
    moveAgent,
    saveSharing,
    saveAgentCallPolicy,
    daemons,
    agents,
    memberSets,
    memberSetsLoading,
    orgSetIds
  } = useConsoleData()
  // Only owners may change organization entries, so only they get a link into
  // Organization settings from the read-only "From organization" group (§8.2);
  // other members see the group and its explanation alone.
  const { myRole, orgPath } = useOrgs()
  const { openModal } = useModal()
  const [loaded, setLoaded] = useState(false)
  const [sharing, setSharing] = useState<SharingValue>({ visibility: agent.visibility, sharedWith: agent.sharedWith })
  const initialSharing = useRef<SharingValue>({ visibility: agent.visibility, sharedWith: agent.sharedWith })
  const [name, setName] = useState(agent.name)
  const [displayName, setDisplayName] = useState(agent.displayName ?? '')
  const initialDisplayName = useRef(agent.displayName ?? '')
  const [runtime, setRuntime] = useState(agent.runtime)
  const initialRuntime = useRef(agent.runtime)
  // The row's `daemon` cannot tell Cloud from one of the org's groups — only the set id plus the
  // org's own list can (daemon-groups.md §2) — so seed through the same mapping the reload uses.
  const initialPlacementValue =
    placementValueOf(
      {
        placementKind: agent.placementKind,
        daemonId: agent.daemon === '—' || agent.daemon === POOL_PLACEMENT ? null : agent.daemon,
        setId: agent.setId
      },
      orgSetIds
    ) ?? ''
  const [daemonId, setDaemonId] = useState(initialPlacementValue)
  const initialDaemonId = useRef(initialPlacementValue)
  const [model, setModel] = useState('')
  const initialModel = useRef('')
  const [outputMode, setOutputMode] = useState<OutputMode | ''>('')
  const initialOutputMode = useRef<OutputMode | ''>('')
  const [showFooter, setShowFooter] = useState(agent.showFooter)
  const initialShowFooter = useRef(agent.showFooter)
  const [showStatusBar, setShowStatusBar] = useState(agent.showStatusBar)
  const initialShowStatusBar = useRef(agent.showStatusBar)
  const [effort, setEffort] = useState('')
  const initialEffort = useRef('')
  const [fastMode, setFastMode] = useState(agent.fastMode)
  const initialFastMode = useRef(agent.fastMode)
  const [permissionMode, setPermissionMode] = useState(permissionModeDefault(agent.runtime))
  const initialPermissionMode = useRef(permissionModeDefault(agent.runtime))
  const [approvalsReviewer, setApprovalsReviewer] = useState<ApprovalsReviewer | ''>(
    agent.approvalsReviewer ?? approvalsReviewerDefault(agent.runtime)
  )
  const initialApprovalsReviewer = useRef<ApprovalsReviewer | ''>(
    agent.approvalsReviewer ?? approvalsReviewerDefault(agent.runtime)
  )
  const [allowRuntimeChangesInChat, setAllowRuntimeChangesInChat] = useState(agent.allowRuntimeChangesInChat)
  const initialAllowRuntimeChangesInChat = useRef(agent.allowRuntimeChangesInChat)
  const [introduceOnJoin, setIntroduceOnJoin] = useState(agent.introduceOnJoin)
  const initialIntroduceOnJoin = useRef(agent.introduceOnJoin)
  const [runInSandbox, setRunInSandbox] = useState(agent.runInSandbox)
  const initialRunInSandbox = useRef(agent.runInSandbox)
  // Agent-call visibility (both directions) — prefilled from the list `Agent`
  // (which already carries the policy), edited here, and saved on the modal's
  // Save alongside the spec/sharing diffs rather than immediately per change.
  const [inboundMode, setInboundMode] = useState<AgentCallPolicy>(agent.callPolicy)
  const initialInboundMode = useRef(agent.callPolicy)
  const [inboundSelected, setInboundSelected] = useState<string[]>(agent.allowedCallerAgentIds)
  const initialInboundSelected = useRef(agent.allowedCallerAgentIds)
  const [outboundMode, setOutboundMode] = useState<AgentCallPolicy>(agent.outboundPolicy)
  const initialOutboundMode = useRef(agent.outboundPolicy)
  const [outboundSelected, setOutboundSelected] = useState<string[]>(agent.allowedTargetAgentIds)
  const initialOutboundSelected = useRef(agent.allowedTargetAgentIds)
  // "Secrets and variables" section — env vars (replaced wholesale) + write-only
  // secrets (key-by-key patch), prefilled from the agent and diffed at save.
  const [envRows, setEnvRows] = useState<EnvVarDraft[]>(() => envRowsFromEnv(agent.env))
  const initialEnvRecord = useRef(envRecordFromRows(envRowsFromEnv(agent.env)))
  const [secretRows, setSecretRows] = useState<SecretDraft[]>(() => secretRowsFromKeys(agent.secretKeys))
  const initialSecretKeys = useRef(agent.secretKeys)
  // #642: the placed daemon reports whether sandboxing is available or mandatory.
  const [sandboxSupported, setSandboxSupported] = useState(agent.sandboxSupported)
  const [sandboxRequired, setSandboxRequired] = useState(agent.sandboxRequired)
  const [repairPlacement, setRepairPlacement] = useState(false)
  const [forceReassign, setForceReassign] = useState(false)
  const [forceConfirmed, setForceConfirmed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const fetched = useRef(false)

  // Section rail: which section is highlighted, and the scroll pane it tracks.
  const [activeSection, setActiveSection] = useState<EditAgentSection>(focusSection ?? 'basics')
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const sectionRefs = useRef(new Map<EditAgentSection, HTMLElement>())
  const pinnedScrollTop = useRef<number | null>(null)
  const sectionRef = (id: EditAgentSection) => (node: HTMLElement | null) => {
    if (node) sectionRefs.current.set(id, node)
    else sectionRefs.current.delete(id)
  }

  // Prefill from the raw spec (GET /agents/:id) — the UI `Agent` drops the exact
  // runtime configuration and placement fields this modal edits.
  //
  // Waits for the group list, because resolving a placement is the one thing this prefill cannot
  // redo: it happens once and seeds BOTH the picker's value and the ref every later change is
  // compared against. Telling a group from Cloud needs the org's own set ids, and without them
  // `placementValueOf` answers Cloud by design — so resolving early would leave a group-placed
  // agent reading as Cloud forever, and make a real group-to-Cloud move look like no change at
  // all and submit nothing. The form is behind its spinner until `loaded`, so this costs nothing
  // visible. `memberSetsLoading` is false in mock mode and after a failed fetch, where an empty
  // list IS the right answer.
  useEffect(() => {
    if (fetched.current || memberSetsLoading) return
    fetched.current = true
    fetchAgentDto(agent.id).then(
      (dto) => {
        setName(dto.name)
        setDisplayName(dto.displayName ?? '')
        initialDisplayName.current = dto.displayName ?? ''
        setRuntime(dto.runtime ?? '')
        initialRuntime.current = dto.runtime ?? ''
        // Through the SAME mapping the list projection uses, so a pool agent reloads as the pool
        // rather than as unplaced — `daemonId` is null for it by design.
        const placement = placementValueOf(dto, orgSetIds) ?? ''
        // The ref stays the SAVED placement — a preselect is a pending change like any other,
        // so the move flow and the Save button see it as one.
        setDaemonId(preselectDaemonId || placement)
        initialDaemonId.current = placement
        setModel(dto.model ?? '')
        initialModel.current = dto.model ?? ''
        setEffort(dto.reasoningEffort ?? '')
        initialEffort.current = dto.reasoningEffort ?? ''
        const nextOutputMode = isOutputMode(dto.outputMode) ? dto.outputMode : ''
        setOutputMode(nextOutputMode)
        initialOutputMode.current = nextOutputMode
        setShowFooter(dto.showFooter ?? true)
        initialShowFooter.current = dto.showFooter ?? true
        setShowStatusBar(dto.showStatusBar ?? false)
        initialShowStatusBar.current = dto.showStatusBar ?? false
        setFastMode(dto.fastMode ?? false)
        initialFastMode.current = dto.fastMode ?? false
        setPermissionMode(dto.permissionMode ?? permissionModeDefault(dto.runtime ?? ''))
        initialPermissionMode.current = dto.permissionMode ?? permissionModeDefault(dto.runtime ?? '')
        const nextApprovalsReviewer = dto.approvalsReviewer ?? approvalsReviewerDefault(dto.runtime ?? '')
        setApprovalsReviewer(nextApprovalsReviewer)
        initialApprovalsReviewer.current = nextApprovalsReviewer
        setAllowRuntimeChangesInChat(dto.allowRuntimeChangesInChat ?? false)
        initialAllowRuntimeChangesInChat.current = dto.allowRuntimeChangesInChat ?? false
        setIntroduceOnJoin(dto.introduceOnJoin ?? false)
        initialIntroduceOnJoin.current = dto.introduceOnJoin ?? false
        setRunInSandbox(dto.runInSandbox ?? false)
        initialRunInSandbox.current = dto.runInSandbox ?? false
        setSandboxSupported(dto.sandboxSupported ?? false)
        setSandboxRequired(dto.sandboxRequired ?? false)
        const fresh: SharingValue = { visibility: dto.visibility, sharedWith: dto.sharedWith }
        setSharing(fresh)
        initialSharing.current = fresh
        // A chained Add-daemon lands the form on a brand-new machine — reset the runtime/model
        // to what it actually reports rather than a pair it cannot run.
        const target = preselectDaemonId ? daemons.find((d) => d.daemonId === preselectDaemonId) : undefined
        const reset = preselectPlacementReset(target?.runtimeModels, dto.runtime ?? '', dto.model ?? '')
        if (reset?.kind === 'runtime') {
          setRuntime(reset.runtime)
          setModel('')
          setEffort('')
          setPermissionMode(permissionModeDefault(reset.runtime))
          setApprovalsReviewer(approvalsReviewerDefault(reset.runtime))
        } else if (reset?.kind === 'model') {
          setModel('')
          setEffort('')
        }
        setLoaded(true)
      },
      (e) => {
        setErr(e instanceof Error ? e.message : String(e))
        setLoaded(true)
      }
    )
    // Re-runs only to pick up the moment the group list finishes loading; `fetched` latches it to
    // one fetch, so this cannot double-fetch.
  }, [agent.id, memberSetsLoading])

  // An unplaced agent defaults to Cloud, then the first placement-ready local daemon.
  const autofilledDaemon = useRef(false)
  useEffect(() => {
    if (!loaded || autofilledDaemon.current || initialDaemonId.current || daemonId) return
    const ready = (d: (typeof daemons)[number]) => d.status === 'online' && d.caps.features.includes('agent-move-v1')
    // With the pool hidden it is not a default either — an unplaced agent lands on a machine.
    const offered = featureFlagEnabled('daemon-pool') ? daemons : daemons.filter((d) => !d.pool)
    const target = offered.find((d) => d.pool && ready(d)) ?? offered.find(ready)
    if (target) {
      autofilledDaemon.current = true
      setDaemonId(target.daemonId)
    }
  }, [loaded, daemons, daemonId])

  // Jump to the requested section once the form has rendered. Both `scrollIntoView`
  // and `scrollTo` resolve to a no-op inside the dialog's nested overflow
  // containers, so the pane's `scrollTop` is assigned outright (same technique the
  // Add-agent modal uses). Gated on `loaded` — the section nodes only exist then.
  useEffect(() => {
    if (!loaded) return
    const target = focusSection ?? 'basics'
    setActiveSection(target)
    const pane = scrollRef.current
    const node = sectionRefs.current.get(target)
    if (!pane || !node) return
    pane.scrollTop = pane.scrollTop + node.getBoundingClientRect().top - pane.getBoundingClientRect().top - 20
    pinnedScrollTop.current = pane.scrollTop
  }, [loaded, focusSection])

  const goToSection = (id: EditAgentSection) => {
    setActiveSection(id)
    const pane = scrollRef.current
    const node = sectionRefs.current.get(id)
    if (!pane || !node) return
    pane.scrollTop = pane.scrollTop + node.getBoundingClientRect().top - pane.getBoundingClientRect().top - 20
    pinnedScrollTop.current = pane.scrollTop
  }

  // Scroll-spy: highlight the last section whose heading crossed the top of the
  // scroller; reaching the bottom always selects the final (short) section.
  // Re-armed on `loaded` because the scroll pane only mounts after the fetch.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const sync = () => {
      if (pinnedScrollTop.current !== null) {
        if (Math.abs(el.scrollTop - pinnedScrollTop.current) < 2) return
        pinnedScrollTop.current = null
      }
      const scrollable = el.scrollHeight - el.clientHeight > 8
      if (scrollable && el.scrollTop + el.clientHeight >= el.scrollHeight - 4) {
        setActiveSection(SECTIONS[SECTIONS.length - 1]!.id)
        return
      }
      const paneTop = el.getBoundingClientRect().top
      let current = SECTIONS[0]!.id
      for (const s of SECTIONS) {
        const node = sectionRefs.current.get(s.id)
        if (node && node.getBoundingClientRect().top - paneTop <= 24) current = s.id
      }
      setActiveSection(current)
    }
    sync()
    el.addEventListener('scroll', sync, { passive: true })
    return () => el.removeEventListener('scroll', sync)
  }, [loaded])

  const moveReady = (d: (typeof daemons)[number] | undefined) =>
    !!d && d.status === 'online' && d.caps.features.includes('agent-move-v1')
  // The group the picker currently names, if any — the one thing `daemonId` alone cannot say.
  const selectedGroupId = groupSetIdOf(daemonId)
  const selectedGroup = memberSets.find((group) => group.setId === selectedGroupId)
  const memberOf = (group: MemberSetRow | undefined) =>
    group && daemons.find((d) => group.memberDaemonIds.includes(d.daemonId) && moveReady(d))
  const selectedGroupServing = memberOf(selectedGroup) !== undefined
  const daemonChoices = editAgentDaemonChoices(
    daemons,
    daemonId,
    initialDaemonId.current,
    featureFlagEnabled('daemon-pool')
  )
  // The daemon whose reported CAPABILITIES the form reads — one live member for a set target, and
  // never the placement itself.
  const daemon = editAgentCapabilitySource(daemons, daemonId, memberSets, daemonChoices.poolChoice)
  const sourceDaemon = daemons.find((d) => d.daemonId === initialDaemonId.current)
  const daemonChanged = daemonId !== initialDaemonId.current
  const initialPlacement = daemonChanged && !initialDaemonId.current
  const placementRequested = daemonChanged || repairPlacement
  // Placement consumes the durable agent definition. Pending execution config
  // is therefore saved first so the selected runtime/model and call policy ride
  // the target activation bundle. Sharing is saved last because a valid edit may
  // remove the current editor's own access.
  const selectedSandboxRequired = daemonChanged
    ? (daemon?.caps.features.includes('sandbox-required') ?? false)
    : sandboxRequired
  const selectedSandboxSupported = daemonChanged
    ? selectedSandboxRequired || (daemon?.caps.features.includes('sandbox') ?? false)
    : sandboxSupported
  const effectiveRunInSandbox = selectedSandboxRequired || (selectedSandboxSupported && runInSandbox)
  const poolServing = daemons.some((candidate) => candidate.pool && moveReady(candidate))
  const daemonOptions: DaemonSelectOption[] = [
    // With the flag off the picker offers Cloud only to an agent already ON it — same rule
    // the groups below follow, and for the same reason: "No daemon" for a placed agent is untrue.
    ...(daemonChoices.offerPool
      ? [
          {
            // The POOL, named as itself. The server picks the member — and re-picks it after every
            // rollout, which is the whole reason this stopped being a member id.
            value: POOL_PLACEMENT,
            label: poolLabel(),
            ...(poolServing ? {} : { meta: 'unavailable' }),
            title: poolServing ? poolTagline() : `${poolLabel()} is currently unavailable.`,
            kind: 'pool' as const,
            disabled: initialDaemonId.current !== POOL_PLACEMENT && !poolServing
          }
        ]
      : []),
    ...(daemonChoices.currentPoolChoice
      ? [
          {
            value: daemonChoices.currentPoolChoice.daemonId,
            label: 'Current placement',
            title: `Currently on an unavailable node — select ${poolLabel()} above to recover.`
          }
        ]
      : []),
    // The org's own groups sit with Cloud: same kind of target, same promise — lose any one member
    // and the duty re-grants to another (daemon-groups.md §2). A group with nothing serving stays
    // listed but disabled, unless it is where the agent already is.
    // With the flag off the picker offers no group — EXCEPT the one this agent is already on.
    // Dropping it would show "No daemon" for a placed agent, which is simply untrue, and a rollback
    // is exactly when a truthful current placement matters most.
    ...(featureFlagEnabled('daemon-groups')
      ? memberSets
      : memberSets.filter((group) => groupPlacementValue(group.setId) === initialDaemonId.current)
    ).map((group) => {
      const serving = group.memberDaemonIds.some((id) => moveReady(daemons.find((d) => d.daemonId === id)))
      const current = groupPlacementValue(group.setId) === initialDaemonId.current
      return {
        value: groupPlacementValue(group.setId),
        label: group.name,
        meta: `${group.memberDaemonIds.length} daemon${group.memberDaemonIds.length === 1 ? '' : 's'}`,
        title: serving
          ? 'Any daemon in the group can serve this agent.'
          : group.memberDaemonIds.length === 0
            ? 'No daemons in this group yet.'
            : 'No daemon in this group is serving right now.',
        kind: 'group' as const,
        disabled: !current && !serving
      }
    }),
    ...(!initialDaemonId.current ? [{ value: '', label: 'No daemon', title: 'Leave this agent inactive.' }] : []),
    ...(daemonId && !daemon && !selectedGroup && daemonId !== POOL_PLACEMENT
      ? [
          {
            value: daemonId,
            label: `Current daemon (${daemonId.slice(0, 8)})`,
            title: 'This daemon is no longer visible.'
          }
        ]
      : []),
    ...daemonChoices.localChoices.map((candidate) => {
      const eligible = moveReady(candidate)
      const current = candidate.daemonId === initialDaemonId.current
      return {
        value: candidate.daemonId,
        label: candidate.name,
        ...(candidate.status !== 'online'
          ? { meta: 'offline' }
          : !candidate.caps.features.includes('agent-move-v1')
            ? { meta: 'needs update' }
            : {}),
        title:
          candidate.status !== 'online'
            ? 'Offline — bring this machine online to use it.'
            : !candidate.caps.features.includes('agent-move-v1')
              ? 'Upgrade required before this machine can host the agent.'
              : 'Uses the credentials on this machine.',
        disabled: !current && !eligible
      }
    }),
    // Last row: no machine to pick means the picker itself offers connecting one.
    { value: ADD_DAEMON, label: 'Add daemon', title: 'Connect a new machine to this org.', icon: 'plus' }
  ]
  const sourceUnavailable = !!sourceDaemon && !moveReady(sourceDaemon)
  const sourceOffline = sourceDaemon?.status === 'offline'
  const forceEligible = daemonChanged && !initialPlacement && sourceOffline && moveReady(daemon)
  const forceMove = forceReassign && forceEligible
  const sourceBlocksSafeMove = daemonChanged && sourceUnavailable && !forceMove

  // Runtime options come from the SELECTED daemon's reported profiles (same source as
  // the Add-agent picker); fall back to the static runtime list when the daemon reports
  // none. Keep the agent's current runtime selectable so changing placement never
  // silently rewrites it.
  const reportedRuntimeIds = daemon?.runtimeModels.map((r) => r.runtime) ?? []
  const runtimeIds = reportedRuntimeIds.length ? reportedRuntimeIds : FALLBACK_RUNTIME_IDS
  const runtimeOptions = runtime && !runtimeIds.includes(runtime) ? [runtime, ...runtimeIds] : runtimeIds
  // Runtimes the daemon reports as logged out — marked in the picker, never blocked.
  // An agent may legitimately sit on one (docs/designs/preset-agents.md §3.2), so this
  // surfaces the state on the choice rather than taking the choice away.
  const runtimesNeedingLogin = loginRequiredRuntimeIds(daemon)
  const runtimeMeta = acpRuntime(acpRegistry, runtime)
  // Models are only what the daemon reports for this runtime — advertised ids
  // verbatim, never a synthesized "Default" entry: an agent without an explicit
  // model DISPLAYS the runtime's resolved default (else the first model) — the
  // stored value stays '' until the user picks one themselves, so opening+saving
  // never silently pins. A runtime that advertises nothing (cursor) leaves the
  // picker inert. During a move a stale stored id stays visible as unavailable
  // so Save can require an explicit compatible choice.
  const runtimeProfile = daemon?.runtimeModels.find((r) => r.runtime === runtime)
  const reportedModels = runtimeProfile?.models ?? []
  const modelCatalog = runtimeProfile?.modelCatalog ?? undefined
  const selectedModel =
    model && (reportedModels.includes(model) || daemonChanged) ? model : preferredModelFor(daemon, runtime)
  const modelOptions =
    selectedModel && !reportedModels.includes(selectedModel) ? [selectedModel, ...reportedModels] : reportedModels
  const modelSelectable = modelOptions.length > 0
  const runtimeSupportsModes = supportsModes(runtime)
  // Dynamic-first vocabularies (runtime-model-catalog.md §7): the SELECTED
  // model's discovered capability drives the effort/fast controls, the catalog's
  // runtime-level list the permission modes; the static tables stay the fallback
  // when the catalog is absent. Discovered efforts decide visibility themselves
  // ([] ⇒ the model has no effort selector); the static fallback keeps the
  // legacy per-runtime supportsModes gate. A catalog arriving mid-edit only
  // swaps the option lists — a stored/selected value it no longer offers stays
  // visible as unavailable (the stale-model idiom above), never auto-cleared,
  // so the diff-based PATCH can't write a field the user didn't touch.
  const capability = modelCapability(daemon, runtime, selectedModel)
  const effortChoices = effortChoicesFor(runtime, capability)
  const showEffort = capability?.efforts ? effortChoices.length > 0 : runtimeSupportsModes
  const effortOptions =
    capability?.efforts && effort && !effortChoices.some((o) => o.value === effort)
      ? [...effortChoices, { value: effort, label: `${effortLabel(runtime, effort)} (unavailable)` }]
      : effortChoices
  const fastModeAvailable = fastModeAvailableFor(runtime, capability)
  const permissionChoices = permissionModeChoicesFor(runtime, modelCatalog)
  const showPermission = !!modelCatalog?.permissionModes?.length || runtimeSupportsModes
  const permissionModeOptions =
    modelCatalog?.permissionModes?.length && !permissionChoices.some((o) => o.v === permissionMode)
      ? [
          ...permissionChoices,
          { v: permissionMode, l: `${permissionModeLabel(runtime, permissionMode)} (unavailable)` }
        ]
      : permissionChoices
  const permissionOptions = permissionModePresets(runtime, permissionModeOptions)
  const selectedPermissionModePreset = selectedPermissionPreset(runtime, permissionMode, approvalsReviewer)
  const runtimeUnavailable = daemonChanged && reportedRuntimeIds.length > 0 && !reportedRuntimeIds.includes(runtime)
  const modelUnavailable =
    daemonChanged && !!selectedModel && reportedModels.length > 0 && !reportedModels.includes(selectedModel)

  // Agent-call reachability, computed with THIS agent's in-progress policy so the
  // "X of Y" hints track the pending edits (same graph the standalone card built).
  const peers = useMemo(() => agents.filter((candidate) => candidate.id !== agent.id), [agents, agent.id])
  const reachability = useMemo(
    () =>
      buildAgentReachabilityGraph(
        agents.map((candidate) =>
          candidate.id === agent.id
            ? {
                ...candidate,
                callPolicy: inboundMode,
                allowedCallerAgentIds: inboundSelected,
                outboundPolicy: outboundMode,
                allowedTargetAgentIds: outboundSelected
              }
            : candidate
        )
      ),
    [agent.id, agents, inboundMode, inboundSelected, outboundMode, outboundSelected]
  )
  const inboundEffectivePeerIds = reachability.incomingByAgentId.get(agent.id) ?? []
  const outboundEffectivePeerIds = reachability.outgoingByAgentId.get(agent.id) ?? []
  const callVisibilityEditable = agent.canEdit

  // Switching runtime invalidates the model and the effort level (both vocabularies
  // are per-runtime), so reset both to the runtime default. (MCP enablement is edited
  // on the agent's Tools & Skills card, not here.)
  const onRuntimeChange = (nextRuntime: string) => {
    setRuntime(nextRuntime)
    setModel('')
    setEffort('')
    setPermissionMode(permissionModeDefault(nextRuntime))
    setApprovalsReviewer(approvalsReviewerDefault(nextRuntime))
  }

  const normalizedDisplayName = displayName.trim() ? displayName.trim() : null
  // env is replaced wholesale; secrets is a key-by-key merge (set/replace/delete).
  const envRecord = envRecordFromRows(envRows)
  const secretsPatch = secretsPatchFromRows(secretRows, initialSecretKeys.current)
  const envChanged =
    Object.keys(envRecord).length !== Object.keys(initialEnvRecord.current).length ||
    Object.keys(envRecord).some((k) => envRecord[k] !== initialEnvRecord.current[k])
  const secretsChanged = Object.keys(secretsPatch).length > 0
  const envSecretError = envSecretsError(envRows, secretRows)
  const patch: UpdateAgentInput = {
    ...(normalizedDisplayName !== (initialDisplayName.current.trim() || null)
      ? { displayName: normalizedDisplayName }
      : {}),
    ...(model !== initialModel.current ? { model: model || null } : {}),
    ...(runtime.trim() !== initialRuntime.current ? { runtime: runtime.trim() } : {}),
    ...(effort !== initialEffort.current ? { reasoningEffort: effort || null } : {}),
    ...(outputMode !== initialOutputMode.current ? { outputMode: outputMode || null } : {}),
    ...(showFooter !== initialShowFooter.current ? { showFooter } : {}),
    ...(showStatusBar !== initialShowStatusBar.current ? { showStatusBar } : {}),
    ...(fastMode !== initialFastMode.current ? { fastMode } : {}),
    ...(permissionMode !== initialPermissionMode.current ? { permissionMode } : {}),
    ...(approvalsReviewer !== initialApprovalsReviewer.current ? { approvalsReviewer: approvalsReviewer || null } : {}),
    ...(allowRuntimeChangesInChat !== initialAllowRuntimeChangesInChat.current ? { allowRuntimeChangesInChat } : {}),
    ...(introduceOnJoin !== initialIntroduceOnJoin.current ? { introduceOnJoin } : {}),
    ...(runInSandbox !== initialRunInSandbox.current ? { runInSandbox } : {}),
    ...(envChanged ? { env: envRecord } : {}),
    ...(secretsChanged ? { secrets: secretsPatch } : {})
  }
  const hasSpecChanges = Object.keys(patch).length > 0
  const hasSharingChanges = !sameSharing(sharing, initialSharing.current)
  const hasCallPolicyChanges =
    inboundMode !== initialInboundMode.current ||
    outboundMode !== initialOutboundMode.current ||
    !sameIds(inboundSelected, initialInboundSelected.current) ||
    !sameIds(outboundSelected, initialOutboundSelected.current)

  const save = async () => {
    if (saving) return
    if (envSecretError) {
      setErr(envSecretError)
      return
    }
    if (daemonChanged) {
      // A restricted current daemon may be intentionally absent from this
      // viewer's daemon list. Let the server perform the authoritative source
      // readiness check in that case; only reject a source we can actually see.
      if (initialDaemonId.current && sourceDaemon && !moveReady(sourceDaemon) && !forceMove) {
        setErr(
          sourceDaemon.status === 'offline'
            ? `To move safely, bring ${sourceDaemon.name} online, then retry.`
            : `Upgrade ${sourceDaemon.name} before moving this agent.`
        )
        return
      }
      if (forceMove && !forceConfirmed) {
        setErr(`Confirm that ${sourceDaemon?.name ?? 'the source daemon'} is permanently stopped.`)
        return
      }
      // A set is a target, not a member: ready when any live member could serve it.
      const targetReady =
        daemonId === POOL_PLACEMENT ? poolServing : selectedGroup ? selectedGroupServing : moveReady(daemon)
      if (!targetReady) {
        setErr(
          daemonId === POOL_PLACEMENT
            ? `${poolLabel()} has no online member right now; try again shortly.`
            : selectedGroup
              ? `No daemon in ${selectedGroup.name} is serving right now; try again shortly.`
              : 'Choose an online daemon that supports agent moves.'
        )
        return
      }
      // Placement is where a deferred runtime becomes mandatory (§3.2). Ahead of
      // `runtimeUnavailable`, which an unset runtime also trips — a target that
      // advertises profiles cannot advertise the empty one, and "does not
      // advertise the — runtime" is not the problem to report.
      if (initialPlacement && !runtime.trim()) {
        setErr('Choose a runtime before placing this agent on a daemon.')
        return
      }
      if (runtimeUnavailable) {
        setErr(
          `${daemon?.name ?? poolLabel()} does not advertise the ${runtimeLabel(runtime, runtimeMeta?.name)} runtime.`
        )
        return
      }
      if (modelUnavailable) {
        // Reachable only when the target DOES advertise models (see
        // `modelUnavailable`), so the picker always has a real id to point at —
        // never a synthesized "Default" the runtime does not offer.
        setErr(`${daemon?.name ?? poolLabel()} does not advertise model “${selectedModel}”. Choose one of its models.`)
        return
      }
    }
    if (repairPlacement && !daemonId) {
      setErr('This agent has no current daemon to repair.')
      return
    }
    if (repairPlacement && daemon && !moveReady(daemon)) {
      setErr('The current daemon must be online and upgraded before this agent can be repaired.')
      return
    }
    setSaving(true)
    setErr(null)
    try {
      // `name` is intentionally never sent: the slug is the daemon-facing handle
      // (workspace dir, launch key) and is immutable in the console — only the
      // display name is renameable.
      // Description is edited on its own card (EditDescriptionModal) — never sent here.
      // Save daemon-affecting settings before placement so the target receives
      // one current activation snapshot. These endpoints are intentionally
      // durable: if placement later fails, the completed edits remain saved.
      if (hasSpecChanges) await updateAgent(agent.id, patch)
      // Agent-call visibility is a normal agent edit and uses canEdit.
      if (hasCallPolicyChanges) {
        const body: AgentCallPolicyInput = {
          callPolicy: inboundMode,
          allowedCallerAgentIds: inboundMode === 'selected' ? normalizeSelected(agent.id, inboundSelected) : [],
          outboundPolicy: outboundMode,
          allowedTargetAgentIds: outboundMode === 'selected' ? normalizeSelected(agent.id, outboundSelected) : []
        }
        await saveAgentCallPolicy(agent.id, body)
      }
      if (placementRequested) {
        const target =
          daemonId === POOL_PLACEMENT
            ? { kind: 'pool' as const }
            : selectedGroup
              ? { kind: 'set' as const, setId: selectedGroup.setId }
              : { kind: 'daemon' as const, daemonId }
        await moveAgent(agent.id, target, forceMove ? { force: true } : undefined)
      }
      // Sharing uses canManageSharing and may intentionally remove this editor's
      // own visibility. Apply it only after every operation that still needs the
      // editor's authorization, including placement.
      if (hasSharingChanges) await saveSharing('agents', agent.id, sharing)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setSaving(false)
    }
  }

  const target = <span className="font-mono text-[12.5px]">{agentLabel(agent)}</span>

  return (
    <>
      <div className="modalhead">
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">
          Edit <span className="mono text-[14px]">{agent.name}</span>
        </span>
        <button className="iconbtn" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
      {!loaded ? (
        <div className="modalbody flex justify-center py-8">
          <Spinner size={28} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col desktop:min-h-[420px] desktop:flex-row">
          {/* Section rail: a column beside the form on desktop, a scrollable strip
              above it on phones (a 172px rail would eat a bottom sheet). */}
          <nav className="flex flex-none items-center gap-1 overflow-x-auto border-b border-(--border-subtle) bg-(--surface-sunken) p-2 desktop:w-[200px] desktop:flex-col desktop:items-stretch desktop:gap-[2px] desktop:overflow-x-visible desktop:overflow-y-auto desktop:border-r desktop:border-b-0 desktop:py-[10px]">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                className={activeSection === s.id ? RAIL_ITEM_ON : RAIL_ITEM_OFF}
                onClick={() => goToSection(s.id)}
              >
                <Icon
                  name={s.icon}
                  size={14}
                  color={activeSection === s.id ? 'var(--brand)' : 'var(--text-tertiary)'}
                  className="flex-none"
                />
                <span className="truncate">{s.label}</span>
              </button>
            ))}
          </nav>
          <div ref={scrollRef} className="min-w-0 flex-1 overflow-y-auto p-5">
            <section ref={sectionRef('basics')}>
              <div className="font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">Basics</div>
              <div className="mt-[13px] grid grid-cols-1 gap-[14px] desktop:grid-cols-2">
                <div className="fld">
                  <span className="fldlbl">Name</span>
                  <input
                    className="inp mn cursor-not-allowed text-(--text-tertiary)"
                    value={name}
                    disabled
                    aria-label="Name (read-only)"
                  />
                </div>
                <div className="fld">
                  <span className="fldlbl">Display name</span>
                  {/* Built-in preset agents keep their fixed brand identity — the CP
                      refuses the change too. */}
                  <input
                    className="inp"
                    placeholder="Deploy Bot (optional)"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    disabled={!!agent.builtin}
                    title={agent.builtin ? 'Built-in agents keep their name' : undefined}
                    autoFocus={!agent.builtin}
                  />
                </div>
                <div className="fld desktop:col-span-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="fldlbl">Runs on</span>
                    {!!initialDaemonId.current && !daemonChanged && (
                      <button
                        type="button"
                        className="font-sans text-[11.5px] font-medium leading-normal text-(--accent) hover:underline"
                        onClick={() => {
                          setRepairPlacement((value) => !value)
                          setForceReassign(false)
                          setForceConfirmed(false)
                          setErr(null)
                        }}
                      >
                        {repairPlacement ? 'Cancel repair' : 'Repair placement'}
                      </button>
                    )}
                  </div>
                  <DaemonSelect
                    value={daemonId}
                    options={daemonOptions}
                    placeholder="No daemon"
                    onChange={(nextDaemonId) => {
                      // Chaining through ModalProvider replaces this dialog; Continue reopens it
                      // with the fresh daemon listed (same path as the unplaced agent's chip).
                      if (nextDaemonId === ADD_DAEMON) {
                        openModal('daemon', agent, { focusSection: 'basics' })
                        return
                      }
                      setDaemonId(nextDaemonId)
                      setRepairPlacement(false)
                      setForceReassign(false)
                      setForceConfirmed(false)
                      setErr(null)
                    }}
                  />
                  {sourceDaemon && sourceUnavailable && (
                    <div className="mt-2 flex items-start gap-[9px] rounded-md border border-(--amber-500) bg-(--status-paused-soft) px-3 py-[10px]">
                      <Icon name="triangle-alert" size={15} color="var(--amber-500)" className="mt-[1px] flex-none" />
                      <div className="min-w-0 flex-1">
                        <div className="font-sans text-[12.5px] font-semibold leading-normal text-(--text-primary)">
                          Safe move unavailable
                        </div>
                        <div className="mt-[3px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-secondary)">
                          {sourceOffline ? (
                            <>
                              To move safely, bring{' '}
                              <span className="font-semibold text-(--text-primary)">{sourceDaemon.name}</span> online,
                              then retry. The existing copy must stop before this agent is activated elsewhere.
                            </>
                          ) : (
                            <>
                              Upgrade <span className="font-semibold text-(--text-primary)">{sourceDaemon.name}</span>{' '}
                              before moving this agent.
                            </>
                          )}
                        </div>
                        {sourceOffline && !daemonChanged && (
                          <div className="mt-[5px] font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)">
                            Select an online destination to see the force reassign option.
                          </div>
                        )}
                        {forceEligible && (
                          <div className="mt-[9px] flex flex-col gap-2">
                            <Button
                              variant={forceReassign ? 'ghost' : 'secondary'}
                              size="xs"
                              onClick={() => {
                                setForceReassign((value) => !value)
                                setForceConfirmed(false)
                                setErr(null)
                              }}
                            >
                              <Icon name={forceReassign ? 'x' : 'triangle-alert'} size={13} />
                              {forceReassign ? 'Cancel force reassign' : 'Force reassign'}
                            </Button>
                            {forceReassign && (
                              <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-(--status-error) bg-(--status-error-soft) px-3 py-[10px]">
                                <input
                                  type="checkbox"
                                  className="mt-[2px] flex-none accent-(--brand)"
                                  checked={forceConfirmed}
                                  onChange={(e) => {
                                    setForceConfirmed(e.target.checked)
                                    setErr(null)
                                  }}
                                />
                                <span className="font-sans text-[12px] font-normal leading-[1.5] text-(--text-secondary)">
                                  I confirm that{' '}
                                  <span className="font-semibold text-(--text-primary)">{sourceDaemon.name}</span> is
                                  permanently stopped and cannot reconnect. If it is still running, both copies may
                                  process messages.
                                </span>
                              </label>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
                <div className="fld">
                  <span className="fldlbl">Runtime</span>
                  <RuntimeSelect
                    value={runtime}
                    options={runtimeOptions}
                    needsLogin={runtimesNeedingLogin}
                    onChange={onRuntimeChange}
                  />
                </div>
                <div className="fld">
                  <span className="fldlbl">Model</span>
                  {/* No advertised models ⇒ nothing to choose: an inert em-dash field
                      rather than a fabricated "Default" entry the runtime never offered. */}
                  <div
                    className={modelSelectable ? 'inp relative' : 'inp cursor-not-allowed'}
                    title={modelSelectable ? undefined : 'This runtime reports no selectable models'}
                  >
                    <span className={modelSelectable ? undefined : 'text-(--text-tertiary)'}>
                      {modelSelectable ? modelLabel(selectedModel) : '—'}
                    </span>
                    {modelSelectable && (
                      <>
                        <Icon name="chevron-down" size={15} color="var(--text-tertiary)" />
                        <select
                          value={selectedModel}
                          onChange={(e) => {
                            const next = e.target.value
                            setModel(next)
                            // Picking a model resolves an effort the new model doesn't offer:
                            // its default level, else the nearest available tier.
                            setEffort((cur) =>
                              resolveEffortForModel(runtime, modelCapability(daemon, runtime, next), cur)
                            )
                          }}
                          className="absolute inset-0 cursor-pointer opacity-0"
                          aria-label="Model"
                        >
                          {modelOptions.map((m) => (
                            <option key={m} value={m}>
                              {modelLabel(m)}
                              {!reportedModels.includes(m) ? ' (unavailable)' : ''}
                            </option>
                          ))}
                        </select>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </section>

            <section ref={sectionRef('runtime')} className="mt-5 border-t border-(--border-subtle) pt-5">
              <div className="font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">Runtime</div>
              <div className="mt-[13px] grid grid-cols-1 gap-[14px] desktop:grid-cols-2">
                {(showEffort || fastModeAvailable || showPermission) && (
                  <div className="fld desktop:col-span-2">
                    <div className="grid grid-cols-1 gap-x-7 gap-y-[14px] desktop:grid-cols-[minmax(0,1fr)_auto]">
                      {showEffort && (
                        <div className="flex min-w-0 flex-col gap-[6px]">
                          <span className="fldlbl">{effortField(runtime).label}</span>
                          <div className="pillbar self-start">
                            {effortOptions.map((o) => (
                              <button
                                key={o.value}
                                type="button"
                                title={o.description}
                                className={
                                  displayedEffort(effort, effortChoices, capability?.defaultEffort) === o.value
                                    ? 'pill on px-[10px] py-1 text-[12px]'
                                    : 'pill px-[10px] py-1 text-[12px]'
                                }
                                onClick={() => setEffort(o.value)}
                              >
                                {o.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      {fastModeAvailable && (
                        <div className="flex flex-col gap-[6px]">
                          <span className="fldlbl">Fast mode</span>
                          <div className="pillbar self-start">
                            <button
                              type="button"
                              className={
                                fastMode ? 'pill on px-[10px] py-1 text-[12px]' : 'pill px-[10px] py-1 text-[12px]'
                              }
                              onClick={() => setFastMode(true)}
                            >
                              On
                            </button>
                            <button
                              type="button"
                              className={
                                fastMode ? 'pill px-[10px] py-1 text-[12px]' : 'pill on px-[10px] py-1 text-[12px]'
                              }
                              onClick={() => setFastMode(false)}
                            >
                              Off
                            </button>
                          </div>
                        </div>
                      )}
                      {showPermission && (
                        <div className="flex min-w-0 flex-col gap-[6px] desktop:col-span-2">
                          <span className="fldlbl">Permission mode</span>
                          <div className="pillbar max-w-full overflow-x-auto self-start">
                            {permissionOptions.map((o) => (
                              <button
                                key={o.v}
                                type="button"
                                title={o.description}
                                className={
                                  selectedPermissionModePreset === o.v
                                    ? 'pill on whitespace-nowrap px-[10px] py-1 text-[12px]'
                                    : 'pill whitespace-nowrap px-[10px] py-1 text-[12px]'
                                }
                                onClick={() => {
                                  const next = permissionPresetSettings(runtime, o.v)
                                  setPermissionMode(next.permissionMode)
                                  setApprovalsReviewer(next.approvalsReviewer)
                                }}
                              >
                                {o.l}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
                <RuntimeChatField checked={allowRuntimeChangesInChat} onChange={setAllowRuntimeChangesInChat} />
                <SandboxField
                  checked={effectiveRunInSandbox}
                  supported={selectedSandboxSupported}
                  required={selectedSandboxRequired}
                  disabled={placementRequested}
                  disabledDetail="Save the computer change before adjusting sandboxing."
                  clusterPlacement={daemonId === POOL_PLACEMENT}
                  onChange={setRunInSandbox}
                />
                <OutputModeField
                  className="desktop:col-span-2"
                  value={outputMode}
                  onChange={(mode) => setOutputMode(mode)}
                  showFooter={showFooter}
                  onShowFooterChange={setShowFooter}
                  showStatusBar={showStatusBar}
                  onShowStatusBarChange={setShowStatusBar}
                />
                <div className="fld desktop:col-span-2">
                  <span className="fldlbl">Introduce on channel join</span>
                  <div className="inp min-w-0 justify-between gap-3">
                    <span className="inline-flex min-w-0 items-center gap-2">
                      <Icon name="users" size={16} color="var(--text-tertiary)" className="flex-none" />
                      <span className="truncate font-sans text-[13px] font-medium leading-normal text-(--text-secondary)">
                        {introduceOnJoin ? 'On — greets peers on join' : 'Off'}
                      </span>
                    </span>
                    <Toggle checked={introduceOnJoin} onChange={setIntroduceOnJoin} />
                  </div>
                  <span className="mt-[6px] text-[11px] text-(--text-secondary)">
                    When this agent joins a channel, it messages the agents already there to introduce itself — so they
                    know who to delegate to later. Off by default.
                  </span>
                </div>
              </div>
            </section>

            <section ref={sectionRef('access')} className="mt-5 border-t border-(--border-subtle) pt-5">
              <div className="font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">Access</div>
              <div className="flex flex-col gap-[14px]">
                <VisibilityField
                  value={sharing}
                  onChange={setSharing}
                  disabled={!agent.canManageSharing}
                  label="Team visibility"
                />
                <div className="fld">
                  <span className="fldlbl">Agent visibility</span>
                  <div className="flex flex-col gap-3">
                    <AgentCallVisibility
                      variant="section"
                      direction="inbound"
                      mode={inboundMode}
                      selectedIds={inboundSelected}
                      effectivePeerIds={inboundEffectivePeerIds}
                      peers={peers}
                      daemons={daemons}
                      groups={memberSets}
                      target={target}
                      editable={callVisibilityEditable}
                      busy={saving}
                      onChange={(mode, selectedIds) => {
                        setInboundMode(mode)
                        setInboundSelected(selectedIds)
                      }}
                    />
                    <AgentCallVisibility
                      variant="section"
                      direction="outbound"
                      mode={outboundMode}
                      selectedIds={outboundSelected}
                      effectivePeerIds={outboundEffectivePeerIds}
                      peers={peers}
                      daemons={daemons}
                      groups={memberSets}
                      target={target}
                      editable={callVisibilityEditable}
                      busy={saving}
                      onChange={(mode, selectedIds) => {
                        setOutboundMode(mode)
                        setOutboundSelected(selectedIds)
                      }}
                    />
                  </div>
                </div>
              </div>
            </section>

            <section ref={sectionRef('secrets')} className="mt-5 border-t border-(--border-subtle) pt-5">
              <EnvSecretsFields
                envRows={envRows}
                setEnvRows={setEnvRows}
                secretRows={secretRows}
                setSecretRows={setSecretRows}
                // Assigned organization entries render above the editable rows as a
                // read-only group. Only owners get the Manage link; other members
                // see the group and its explanation alone (design §8.2).
                organizationVariables={agent.organizationVariables}
                organizationSecretKeys={agent.organizationSecretKeys}
                {...(myRole === 'owner' ? { organizationSettingsHref: orgPath('/settings') } : {})}
              />
            </section>

            {placementRequested && (
              <div className="mt-[18px] flex items-start gap-[9px] rounded-md border border-(--amber-500) bg-(--status-paused-soft) px-3 py-[11px]">
                <Icon name="alert-triangle" size={15} color="var(--amber-500)" className="mt-[1px] flex-none" />
                {initialPlacement ? (
                  <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
                    This places the unassigned agent on{' '}
                    <span className="font-semibold text-(--text-primary)">{daemon?.name ?? 'the selected daemon'}</span>{' '}
                    from its saved settings. No workspace, memory, or session history is copied from another daemon.
                  </span>
                ) : daemonChanged && forceMove ? (
                  <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
                    Force reassign activates this agent on{' '}
                    <span className="font-semibold text-(--text-primary)">{daemon?.name ?? 'the target daemon'}</span>{' '}
                    without confirmation from{' '}
                    <span className="font-semibold text-(--text-primary)">
                      {sourceDaemon?.name ?? 'the current daemon'}
                    </span>
                    . Local workspace, memory, transcripts, and attachments are not copied. Continue only when the
                    source machine is permanently stopped.
                  </span>
                ) : daemonChanged ? (
                  <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
                    This is a hard cutover. Current turns on{' '}
                    <span className="font-semibold text-(--text-primary)">
                      {sourceDaemon?.name ?? 'the current daemon'}
                    </span>{' '}
                    are cancelled without a final reply. New messages start fresh on{' '}
                    <span className="font-semibold text-(--text-primary)">{daemon?.name ?? 'the target daemon'}</span>.
                    Workspace, memory, and session history stay on the source and are not copied or replayed; GitHub
                    workspaces are re-cloned. Other edits in this dialog are saved as part of the same operation.
                  </span>
                ) : (
                  <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
                    Repair cold-reprovisions this agent on its current daemon from its saved settings. Use it to recover
                    an interrupted move. Current turns are drained; local workspace and memory stay in place.
                  </span>
                )}
              </div>
            )}
            <div className="mt-[14px] flex items-center gap-2 rounded-md bg-(--surface-sunken) px-3 py-[11px] font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
              <Icon name="info" size={14} />
              The agent name is fixed. Edit workspace source and working directory from the Workspace card.
            </div>
            {err && (
              <div className="mt-[14px] flex items-start gap-2 rounded-md border border-(--status-error) bg-(--status-error-soft) px-3 py-[11px] font-sans text-[12.5px] font-normal leading-[1.5] text-(--status-error)">
                <Icon name="triangle-alert" size={15} />
                {err}
              </div>
            )}
          </div>
        </div>
      )}
      <div className="modalfoot">
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant={forceMove ? 'danger' : 'primary'}
          disabled={saving || !loaded || sourceBlocksSafeMove || (forceMove && !forceConfirmed)}
          onClick={() => void save()}
        >
          <Icon name={forceMove ? 'triangle-alert' : 'check'} size={15} />
          {saving
            ? initialPlacement
              ? 'Placing…'
              : forceMove
                ? 'Reassigning…'
                : daemonChanged
                  ? 'Moving…'
                  : repairPlacement
                    ? 'Repairing…'
                    : 'Saving…'
            : initialPlacement
              ? 'Place agent'
              : forceMove
                ? 'Force reassign'
                : daemonChanged
                  ? 'Move agent'
                  : repairPlacement
                    ? 'Repair agent'
                    : 'Save changes'}
        </Button>
      </div>
    </>
  )
}
