// No 'use client' here: rendered only by ModalProvider (the client boundary).

import { useEffect, useRef, useState } from 'react'
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
  type Agent
} from '@/lib/data'
import { acpRuntime, useAcpRegistry } from '@/lib/acp-registry'
import { fetchAgentDto, type UpdateAgentInput } from '@/lib/api'
import { useConsoleData } from '@/lib/data-context'
import { Spinner } from '@/components/marks'
import { Button, Icon, Toggle } from '@/components/ui'
import { RuntimeSelect } from '@/components/console/RuntimeSelect'
import { VisibilityField, sameSharing, type SharingValue } from '@/components/console/VisibilityField'
import { OutputModeField } from '@/components/console/OutputModeField'
import { RuntimeChatField } from '@/components/console/RuntimeChatField'
import { SandboxField } from '@/components/console/SandboxField'
import { isOutputMode, type OutputMode } from '@/lib/output-mode'

export default function EditAgentModal({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const acpRegistry = useAcpRegistry()
  const { updateAgent, moveAgent, saveSharing, daemons } = useConsoleData()
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
  // #642: the placed daemon reports whether sandboxing is available or mandatory.
  const [sandboxSupported, setSandboxSupported] = useState(agent.sandboxSupported)
  const [sandboxRequired, setSandboxRequired] = useState(agent.sandboxRequired)
  const [repairPlacement, setRepairPlacement] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const fetched = useRef(false)

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
        setRuntime(dto.runtime)
        initialRuntime.current = dto.runtime
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
        setPermissionMode(dto.permissionMode ?? permissionModeDefault(dto.runtime))
        initialPermissionMode.current = dto.permissionMode ?? permissionModeDefault(dto.runtime)
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

  // Switching runtime invalidates the model and the effort level (both vocabularies
  // are per-runtime), so reset both to the runtime default. (MCP enablement is edited
  // on the agent's Knowledge & Tools card, not here.)
  const onRuntimeChange = (nextRuntime: string) => {
    setRuntime(nextRuntime)
    setModel('')
    setEffort('')
    setPermissionMode(permissionModeDefault(nextRuntime))
  }

  const normalizedDisplayName = displayName.trim() ? displayName.trim() : null
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
    ...(restrictFileAccess !== initialRestrictFileAccess.current ? { restrictFileAccess } : {})
  }
  const hasSpecChanges = Object.keys(patch).length > 0
  const hasSharingChanges = !sameSharing(sharing, initialSharing.current)

  const save = async () => {
    if (saving) return
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
    if (placementRequested && (hasSpecChanges || hasSharingChanges)) {
      setErr(
        'Move or repair the agent separately from configuration changes. Save those changes first, then reopen it.'
      )
      return
    }
    setSaving(true)
    setErr(null)
    try {
      // `name` is intentionally never sent: the slug is the daemon-facing handle
      // (workspace dir, launch key) and is immutable in the console — only the
      // display name is renameable.
      // Description is edited on its own card (EditDescriptionModal) — never sent here.
      if (placementRequested) await moveAgent(agent.id, daemonId)
      else if (hasSpecChanges) await updateAgent(agent.id, patch)
      // Sharing rides a separate endpoint (canManageSharing gate) — only write when
      // it actually changed.
      if (!placementRequested && hasSharingChanges) await saveSharing('agents', agent.id, sharing)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setSaving(false)
    }
  }

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
      <div className="modalbody">
        {!loaded ? (
          <div className="flex justify-center py-8">
            <Spinner size={28} />
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-[14px] min-[440px]:grid-cols-2">
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
            <div className="fld min-[440px]:col-span-2">
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
                  {!daemonId && (
                    <option value="" disabled>
                      No daemon
                    </option>
                  )}
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
                        setEffort((cur) => resolveEffortForModel(runtime, modelCapability(daemon, runtime, next), cur))
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
            {(showEffort || fastModeAvailable || showPermission) && (
              <div className="fld min-[440px]:col-span-2">
                <div className="grid grid-cols-1 gap-x-7 gap-y-[14px] min-[440px]:grid-cols-[minmax(0,1fr)_auto]">
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
                    <div className="flex min-w-0 flex-col gap-[6px] min-[440px]:col-span-2">
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
              className="min-[440px]:col-span-2"
              value={outputMode}
              onChange={(mode) => setOutputMode(mode)}
              showFooter={showFooter}
              onShowFooterChange={setShowFooter}
            />
            <div className="fld min-[440px]:col-span-2">
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
                When this agent joins a channel, it messages the agents already there to introduce itself — so they know
                who to delegate to later. Off by default.
              </span>
            </div>
            <div className="min-[440px]:col-span-2">
              <VisibilityField
                value={sharing}
                onChange={setSharing}
                creatorUserId={agent.createdBy || null}
                disabled={!agent.canManageSharing}
              />
            </div>
          </div>
        )}
        {loaded && placementRequested && (
          <div className="mt-[14px] flex items-start gap-[9px] rounded-md border border-(--amber-500) bg-(--status-paused-soft) px-3 py-[11px]">
            <Icon name="alert-triangle" size={15} color="var(--amber-500)" className="mt-[1px] flex-none" />
            {initialPlacement ? (
              <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
                This places the unassigned agent on{' '}
                <span className="font-semibold text-(--text-primary)">{daemon?.name ?? 'the selected daemon'}</span>{' '}
                from its saved control-plane definition. No workspace, memory, or session history is copied from another
                daemon.
              </span>
            ) : daemonChanged ? (
              <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
                This is a cold move and must be saved separately from configuration edits. Current turns are drained.
                Workspace and memory on{' '}
                <span className="font-semibold text-(--text-primary)">
                  {sourceDaemon?.name ?? 'the current daemon'}
                </span>{' '}
                stay archived there and are not copied to{' '}
                <span className="font-semibold text-(--text-primary)">{daemon?.name ?? 'the target daemon'}</span>.
                Existing session history remains only on the source and is unavailable in the console after the move;
                GitHub workspaces are re-cloned.
              </span>
            ) : (
              <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
                Repair cold-reprovisions this agent on its current daemon from the saved control-plane definition. Use
                it to recover an interrupted move. Current turns are drained; local workspace and memory stay in place.
              </span>
            )}
          </div>
        )}
        {loaded && (
          <div className="mt-[14px] flex items-center gap-2 rounded-md bg-(--surface-sunken) px-3 py-[11px] font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
            <Icon name="info" size={14} />
            The agent name is fixed. Edit workspace source and working directory from the Workspace card.
          </div>
        )}
        {err && (
          <div className="mt-[14px] flex items-start gap-2 rounded-md border border-(--status-error) bg-(--status-error-soft) px-3 py-[11px] font-sans text-[12.5px] font-normal leading-[1.5] text-(--status-error)">
            <Icon name="triangle-alert" size={15} />
            {err}
          </div>
        )}
      </div>
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
