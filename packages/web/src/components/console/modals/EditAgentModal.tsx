// No 'use client' here: rendered only by ModalProvider (the client boundary).

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  effortChoicesFor,
  effortField,
  effortLabel,
  FALLBACK_RUNTIME_IDS,
  fastModeAvailableFor,
  modelCapability,
  modelLabel,
  displayedEffort,
  preferredModelFor,
  resolveEffortForModel,
  permissionModeChoicesFor,
  permissionModeDefault,
  permissionModeLabel,
  runtimeLabel,
  supportsModes,
  agentLabel,
  type Agent,
  type AgentCallPolicy
} from '@/lib/data'
import { acpRuntime, useAcpRegistry } from '@/lib/acp-registry'
import { fetchAgentDto, type AgentCallPolicyInput, type UpdateAgentInput } from '@/lib/api'
import { useConsoleData } from '@/lib/data-context'
import { buildAgentReachabilityGraph } from '@/lib/agent-reachability'
import { Spinner } from '@/components/marks'
import { Button, Icon, Toggle } from '@/components/ui'
import { RuntimeSelect } from '@/components/console/RuntimeSelect'
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
  onClose
}: {
  agent: Agent
  focusSection?: EditAgentSection
  onClose: () => void
}) {
  const acpRegistry = useAcpRegistry()
  const { updateAgent, moveAgent, saveSharing, saveAgentCallPolicy, daemons, agents } = useConsoleData()
  const [loaded, setLoaded] = useState(false)
  const [sharing, setSharing] = useState<SharingValue>({ visibility: agent.visibility, sharedWith: agent.sharedWith })
  const initialSharing = useRef<SharingValue>({ visibility: agent.visibility, sharedWith: agent.sharedWith })
  const [name, setName] = useState(agent.name)
  const [displayName, setDisplayName] = useState(agent.displayName ?? '')
  const initialDisplayName = useRef(agent.displayName ?? '')
  const [runtime, setRuntime] = useState(agent.runtime)
  const initialRuntime = useRef(agent.runtime)
  const [daemonId, setDaemonId] = useState(agent.daemon === '—' ? '' : agent.daemon)
  const initialDaemonId = useRef(agent.daemon === '—' ? '' : agent.daemon)
  const [model, setModel] = useState('')
  const initialModel = useRef('')
  const [outputMode, setOutputMode] = useState<OutputMode | ''>('')
  const initialOutputMode = useRef<OutputMode | ''>('')
  const [showFooter, setShowFooter] = useState(agent.showFooter)
  const initialShowFooter = useRef(agent.showFooter)
  const [effort, setEffort] = useState('')
  const initialEffort = useRef('')
  const [fastMode, setFastMode] = useState(agent.fastMode)
  const initialFastMode = useRef(agent.fastMode)
  const [permissionMode, setPermissionMode] = useState(permissionModeDefault(agent.runtime))
  const initialPermissionMode = useRef(permissionModeDefault(agent.runtime))
  const [allowRuntimeChangesInChat, setAllowRuntimeChangesInChat] = useState(agent.allowRuntimeChangesInChat)
  const initialAllowRuntimeChangesInChat = useRef(agent.allowRuntimeChangesInChat)
  const [introduceOnJoin, setIntroduceOnJoin] = useState(agent.introduceOnJoin)
  const initialIntroduceOnJoin = useRef(agent.introduceOnJoin)
  const [restrictFileAccess, setRestrictFileAccess] = useState(agent.restrictFileAccess)
  const initialRestrictFileAccess = useRef(agent.restrictFileAccess)
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
  useEffect(() => {
    if (fetched.current) return
    fetched.current = true
    fetchAgentDto(agent.id).then(
      (dto) => {
        setName(dto.name)
        setDisplayName(dto.displayName ?? '')
        initialDisplayName.current = dto.displayName ?? ''
        setRuntime(dto.runtime ?? '')
        initialRuntime.current = dto.runtime ?? ''
        setDaemonId(dto.daemonId ?? '')
        initialDaemonId.current = dto.daemonId ?? ''
        setModel(dto.model ?? '')
        initialModel.current = dto.model ?? ''
        setEffort(dto.reasoningEffort ?? '')
        initialEffort.current = dto.reasoningEffort ?? ''
        const nextOutputMode = isOutputMode(dto.outputMode) ? dto.outputMode : ''
        setOutputMode(nextOutputMode)
        initialOutputMode.current = nextOutputMode
        setShowFooter(dto.showFooter ?? true)
        initialShowFooter.current = dto.showFooter ?? true
        setFastMode(dto.fastMode ?? false)
        initialFastMode.current = dto.fastMode ?? false
        setPermissionMode(dto.permissionMode ?? permissionModeDefault(dto.runtime ?? ''))
        initialPermissionMode.current = dto.permissionMode ?? permissionModeDefault(dto.runtime ?? '')
        setAllowRuntimeChangesInChat(dto.allowRuntimeChangesInChat ?? false)
        initialAllowRuntimeChangesInChat.current = dto.allowRuntimeChangesInChat ?? false
        setIntroduceOnJoin(dto.introduceOnJoin ?? false)
        initialIntroduceOnJoin.current = dto.introduceOnJoin ?? false
        setRestrictFileAccess(dto.restrictFileAccess ?? false)
        initialRestrictFileAccess.current = dto.restrictFileAccess ?? false
        setSandboxSupported(dto.sandboxSupported ?? false)
        setSandboxRequired(dto.sandboxRequired ?? false)
        const fresh: SharingValue = { visibility: dto.visibility, sharedWith: dto.sharedWith }
        setSharing(fresh)
        initialSharing.current = fresh
        setLoaded(true)
      },
      (e) => {
        setErr(e instanceof Error ? e.message : String(e))
        setLoaded(true)
      }
    )
  }, [agent.id])

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

  // Placement choices are operational: only a READY daemon that advertises the
  // acknowledged cold-move protocol can become a new target. The current daemon
  // stays selectable even when it has gone offline (selecting it is a no-op), and
  // a hidden/deleted current daemon gets a synthetic option instead of silently
  // falling back to the first visible machine.
  const sortedDaemons = [...daemons].sort((a, b) => {
    const score = (d: (typeof daemons)[number]) =>
      Number(d.status === 'online') * 2 + Number(d.caps.features.includes('agent-move-v1'))
    return score(b) - score(a)
  })
  const daemon = daemons.find((d) => d.daemonId === daemonId)
  const sourceDaemon = daemons.find((d) => d.daemonId === initialDaemonId.current)
  const daemonChanged = daemonId !== initialDaemonId.current
  const initialPlacement = daemonChanged && !initialDaemonId.current
  const placementRequested = daemonChanged || repairPlacement
  // A cold move or a repair rewrites daemon-local state, so it stays a solo
  // action — configuration edits must be saved separately. An INITIAL placement
  // has no source daemon and nothing to drain, and the CP refuses to place an
  // agent whose runtime is still unset (preset-agents.md §3.2) — the general
  // preset ships exactly that way — so the exec config rides along with it here,
  // committed just before the placement (§3.4's "the picker bundles the runtime
  // choice", on this surface).
  const soloPlacement = placementRequested && !initialPlacement
  const selectedSandboxRequired = daemonChanged
    ? (daemon?.caps.features.includes('sandbox-required') ?? false)
    : sandboxRequired
  const selectedSandboxSupported = daemonChanged
    ? selectedSandboxRequired || (daemon?.caps.features.includes('sandbox') ?? false)
    : sandboxSupported
  const effectiveRunInSandbox = selectedSandboxRequired || (selectedSandboxSupported && restrictFileAccess)
  const moveReady = (d: (typeof daemons)[number] | undefined) =>
    !!d && d.status === 'online' && d.caps.features.includes('agent-move-v1')
  const daemonLabel = daemon?.name ?? (daemonId ? `Current daemon (${daemonId.slice(0, 8)})` : 'No daemon')

  // Runtime options come from the SELECTED daemon's reported profiles (same source as
  // the Add-agent picker); fall back to the static runtime list when the daemon reports
  // none. Keep the agent's current runtime selectable so changing placement never
  // silently rewrites it.
  const reportedRuntimeIds = daemon?.runtimeModels.map((r) => r.runtime) ?? []
  const runtimeIds = reportedRuntimeIds.length ? reportedRuntimeIds : FALLBACK_RUNTIME_IDS
  const runtimeOptions = runtime && !runtimeIds.includes(runtime) ? [runtime, ...runtimeIds] : runtimeIds
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
  const permissionOptions =
    modelCatalog?.permissionModes?.length && !permissionChoices.some((o) => o.v === permissionMode)
      ? [
          ...permissionChoices,
          { v: permissionMode, l: `${permissionModeLabel(runtime, permissionMode)} (unavailable)` }
        ]
      : permissionChoices
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
  const callVisibilityEditable = agent.canManageSharing

  // Switching runtime invalidates the model and the effort level (both vocabularies
  // are per-runtime), so reset both to the runtime default. (MCP enablement is edited
  // on the agent's Tools & Skills card, not here.)
  const onRuntimeChange = (nextRuntime: string) => {
    setRuntime(nextRuntime)
    setModel('')
    setEffort('')
    setPermissionMode(permissionModeDefault(nextRuntime))
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
    ...(fastMode !== initialFastMode.current ? { fastMode } : {}),
    ...(permissionMode !== initialPermissionMode.current ? { permissionMode } : {}),
    ...(allowRuntimeChangesInChat !== initialAllowRuntimeChangesInChat.current ? { allowRuntimeChangesInChat } : {}),
    ...(introduceOnJoin !== initialIntroduceOnJoin.current ? { introduceOnJoin } : {}),
    ...(restrictFileAccess !== initialRestrictFileAccess.current ? { restrictFileAccess } : {}),
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
      if (initialDaemonId.current && sourceDaemon && !moveReady(sourceDaemon)) {
        setErr('The current daemon must be online and upgraded before this agent can move.')
        return
      }
      if (!daemon || !moveReady(daemon)) {
        setErr('Choose an online daemon that supports agent moves.')
        return
      }
      if (runtimeUnavailable) {
        setErr(`${daemon.name} does not advertise the ${runtimeLabel(runtime, runtimeMeta?.name)} runtime.`)
        return
      }
      if (modelUnavailable) {
        // Reachable only when the target DOES advertise models (see
        // `modelUnavailable`), so the picker always has a real id to point at —
        // never a synthesized "Default" the runtime does not offer.
        setErr(`${daemon.name} does not advertise model “${selectedModel}”. Choose one of its models.`)
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
    if (soloPlacement && (hasSpecChanges || hasSharingChanges || hasCallPolicyChanges)) {
      setErr(
        'Move or repair the agent separately from configuration changes. Save those changes first, then reopen it.'
      )
      return
    }
    // Placement is where a deferred runtime becomes mandatory. Say so here rather
    // than surfacing the CP's 409 after the round trip.
    if (initialPlacement && !runtime.trim()) {
      setErr('Choose a runtime before placing this agent on a daemon.')
      return
    }
    setSaving(true)
    setErr(null)
    try {
      // `name` is intentionally never sent: the slug is the daemon-facing handle
      // (workspace dir, launch key) and is immutable in the console — only the
      // display name is renameable.
      // Description is edited on its own card (EditDescriptionModal) — never sent here.
      // Spec first: an initial placement needs the runtime committed before the
      // CP will accept the daemon (a solo move/repair carries no spec diff at all
      // — the guard above rejected one).
      if (hasSpecChanges && !soloPlacement) await updateAgent(agent.id, patch)
      if (placementRequested) await moveAgent(agent.id, daemonId)
      // Sharing + agent-call visibility ride their own endpoints (canManageSharing
      // gate) — only write when they actually changed, and never during a move.
      if (!soloPlacement && hasSharingChanges) await saveSharing('agents', agent.id, sharing)
      if (!soloPlacement && hasCallPolicyChanges) {
        const body: AgentCallPolicyInput = {
          callPolicy: inboundMode,
          allowedCallerAgentIds: inboundMode === 'selected' ? normalizeSelected(agent.id, inboundSelected) : [],
          outboundPolicy: outboundMode,
          allowedTargetAgentIds: outboundMode === 'selected' ? normalizeSelected(agent.id, outboundSelected) : []
        }
        await saveAgentCallPolicy(agent.id, body)
      }
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
                  <input
                    className="inp"
                    placeholder="Deploy Bot (optional)"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    autoFocus
                  />
                </div>
                <div className="fld desktop:col-span-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="fldlbl">Daemon</span>
                    {!!initialDaemonId.current && !daemonChanged && (
                      <button
                        type="button"
                        className="font-sans text-[11.5px] font-medium leading-normal text-(--accent) hover:underline"
                        onClick={() => {
                          setRepairPlacement((value) => !value)
                          setErr(null)
                        }}
                      >
                        {repairPlacement ? 'Cancel repair' : 'Repair placement'}
                      </button>
                    )}
                  </div>
                  <div className="inp relative">
                    <span className={daemon ? 'inline-flex items-center gap-[7px]' : 'text-(--text-tertiary)'}>
                      {daemon && <Icon name="server" size={14} color="var(--text-tertiary)" />}
                      {daemonLabel}
                    </span>
                    <Icon name="chevron-down" size={15} color="var(--text-tertiary)" />
                    <select
                      value={daemonId}
                      onChange={(e) => {
                        setDaemonId(e.target.value)
                        setRepairPlacement(false)
                        setErr(null)
                      }}
                      className="absolute inset-0 cursor-pointer opacity-0"
                      aria-label="Daemon"
                    >
                      {/* An agent that opened unplaced keeps "No daemon" selectable
                          so a chosen target can be taken back — picking one is what
                          turns the dialog into a placement. Never offered to a placed
                          agent: unplacing is not a move. */}
                      {!initialDaemonId.current && <option value="">No daemon</option>}
                      {daemonId && !daemon && <option value={daemonId}>Current daemon ({daemonId.slice(0, 8)})</option>}
                      {sortedDaemons.map((d) => {
                        const current = d.daemonId === initialDaemonId.current
                        const eligible = moveReady(d)
                        const suffix =
                          d.status !== 'online'
                            ? ` (${d.status})`
                            : !d.caps.features.includes('agent-move-v1')
                              ? ' (upgrade required)'
                              : ''
                        return (
                          <option key={d.daemonId} value={d.daemonId} disabled={!current && !eligible}>
                            {d.name}
                            {suffix}
                          </option>
                        )
                      })}
                    </select>
                  </div>
                </div>
                <div className="fld">
                  <span className="fldlbl">Runtime</span>
                  <RuntimeSelect value={runtime} options={runtimeOptions} onChange={onRuntimeChange} />
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
                          <div className="pillbar self-start">
                            {permissionOptions.map((o) => (
                              <button
                                key={o.v}
                                type="button"
                                title={o.description}
                                className={
                                  permissionMode === o.v
                                    ? 'pill on px-[10px] py-1 text-[12px]'
                                    : 'pill px-[10px] py-1 text-[12px]'
                                }
                                onClick={() => setPermissionMode(o.v)}
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
                  onChange={setRestrictFileAccess}
                />
                <OutputModeField
                  className="desktop:col-span-2"
                  value={outputMode}
                  onChange={(mode) => setOutputMode(mode)}
                  showFooter={showFooter}
                  onShowFooterChange={setShowFooter}
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
                  creatorUserId={agent.createdBy || null}
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
              />
            </section>

            {placementRequested && (
              <div className="mt-[18px] flex items-start gap-[9px] rounded-md border border-(--amber-500) bg-(--status-paused-soft) px-3 py-[11px]">
                <Icon name="alert-triangle" size={15} color="var(--amber-500)" className="mt-[1px] flex-none" />
                {initialPlacement ? (
                  <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
                    This places the unassigned agent on{' '}
                    <span className="font-semibold text-(--text-primary)">{daemon?.name ?? 'the selected daemon'}</span>{' '}
                    from its saved control-plane definition. No workspace, memory, or session history is copied from
                    another daemon.
                  </span>
                ) : daemonChanged ? (
                  <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
                    This is a cold move and must be saved separately from configuration edits. Current turns are
                    drained. Workspace and memory on{' '}
                    <span className="font-semibold text-(--text-primary)">
                      {sourceDaemon?.name ?? 'the current daemon'}
                    </span>{' '}
                    stay archived there and are not copied to{' '}
                    <span className="font-semibold text-(--text-primary)">{daemon?.name ?? 'the target daemon'}</span>.
                    Existing session history remains only on the source and is unavailable in the console after the
                    move; GitHub workspaces are re-cloned.
                  </span>
                ) : (
                  <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
                    Repair cold-reprovisions this agent on its current daemon from the saved control-plane definition.
                    Use it to recover an interrupted move. Current turns are drained; local workspace and memory stay in
                    place.
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
        <Button onClick={() => void save()} className={!saving && loaded ? undefined : 'cursor-default opacity-50'}>
          <Icon name="check" size={15} />
          {saving
            ? initialPlacement
              ? 'Placing…'
              : daemonChanged
                ? 'Moving…'
                : repairPlacement
                  ? 'Repairing…'
                  : 'Saving…'
            : initialPlacement
              ? 'Place agent'
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
