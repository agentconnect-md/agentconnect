// No 'use client' here: rendered only by ModalProvider (the client boundary).

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useConsoleData } from '@/lib/data-context'
import { useProfile } from '@/lib/profile'
import type { DaemonConnectDto } from '@/lib/api'
import { daemonCommands } from '@/lib/daemon-commands'
import { Button, Icon } from '@/components/ui'
import { Spinner } from '@/components/marks'
import { VisibilityField, sameSharing, type SharingValue } from '@/components/console/VisibilityField'
import { SessionRetentionField, SESSION_RETENTION_DEFAULT } from '@/components/console/SessionRetentionField'

/** What the CP already gave the provisioned row — skip the /sharing write when the
 *  operator leaves it alone. */
const DEFAULT_SHARING: SharingValue = { visibility: 'org', sharedWith: [] }

interface CommandTab {
  key: string
  label: string
  command: string | null
}

/** A copy-pasteable terminal block whose header is a tab strip: the operator
 *  toggles between the foreground `run` command and the service-install `login`
 *  command, and the copy button copies whichever tab is active. Copy feedback is
 *  keyed by tab so switching tabs resets the transient "copied" state. */
function CommandBox({ tabs, placeholder }: { tabs: CommandTab[]; placeholder: ReactNode }) {
  const [active, setActive] = useState(0)
  const [copied, setCopied] = useState(false)
  const command = tabs[active]?.command ?? null
  const select = (i: number) => {
    setActive(i)
    setCopied(false)
  }
  const copy = async () => {
    if (!command) return
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable (insecure context) — user can still select the text */
    }
  }
  return (
    <div className="overflow-hidden rounded-[9px] border border-(--gray-800) bg-(--gray-1000)">
      <div className="flex items-stretch border-b border-(--gray-800)">
        {tabs.map((tab, i) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => select(i)}
            aria-selected={i === active}
            className={`inline-flex cursor-pointer items-center gap-[6px] border-0 border-b-2 bg-transparent px-[13px] py-[9px] font-mono text-[11px] font-medium leading-normal ${
              i === active
                ? 'border-(--magenta-300) text-[#cdd6e0]'
                : 'border-transparent text-(--text-inverse-dim) hover:text-[#cdd6e0]'
            }`}
          >
            <Icon name="terminal" size={13} />
            {tab.label}
          </button>
        ))}
        <button
          type="button"
          onClick={copy}
          disabled={!command}
          className="ml-auto inline-flex cursor-pointer items-center gap-[5px] border-0 bg-transparent px-[13px] py-[9px] font-mono text-[11px] font-medium leading-normal text-(--text-inverse-dim) disabled:cursor-default disabled:opacity-50"
        >
          <Icon name={copied ? 'check' : 'copy'} size={12} />
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <div className="break-all px-[14px] py-[13px] font-mono text-[12px] leading-[1.7] text-[#cdd6e0]">
        {command ? (
          <div>
            <span className="text-(--magenta-300)">$</span> {command}
          </div>
        ) : (
          placeholder
        )}
      </div>
    </div>
  )
}

// `onDone` (optional) replaces plain close on the connected path's Done button —
// ModalProvider uses it to chain back into the Edit-agent dialog when this modal
// was opened from an agent's "Add daemon" affordance, carrying the daemon just
// connected so that dialog can preselect it. Cancel never chains.
export default function AddDaemonModal({
  onClose,
  onDone,
  registerDismiss
}: {
  onClose: () => void
  onDone?: (daemonId: string) => void
  registerDismiss: (handler: () => void) => () => void
}) {
  const { provisionDaemon, daemons, refresh, deleteDaemon, renameDaemon, setDaemonSessionRetention, saveSharing } =
    useConsoleData()
  const { me } = useProfile()
  const [connect, setConnect] = useState<DaemonConnectDto | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)
  // Optional overrides applied on Done: an empty name keeps the daemon's own
  // reported one, and the default sharing/retention skip their writes entirely.
  const [name, setName] = useState('')
  const [retention, setRetention] = useState(SESSION_RETENTION_DEFAULT)
  const [sharing, setSharing] = useState<SharingValue>(DEFAULT_SHARING)
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState<string | null>(null)
  const provisioned = useRef(false)
  const provisionPending = useRef<Promise<DaemonConnectDto> | null>(null)
  // Set the moment a dismissal is honoured, so an in-flight save can't act on a
  // dialog the operator has already left.
  const dismissed = useRef(false)

  // Mint a daemon + its API key + start command once when the modal opens. The ref
  // guard dedupes StrictMode's double-invoke so only one key is minted; we
  // deliberately don't gate setState on an "active" flag, because StrictMode's
  // first-pass cleanup would then discard the (only) fetch's result.
  useEffect(() => {
    if (provisioned.current) return
    provisioned.current = true
    const pending = provisionDaemon()
    provisionPending.current = pending
    pending.then(setConnect).catch((e) => setErr(e instanceof Error ? e.message : String(e)))
  }, [provisionDaemon])

  // Onboarding writes the daemon row immediately (status `pending`), so presence
  // alone isn't "connected" — poll the fleet until OUR daemon reports `online`
  // (it authenticated + registered over the WS).
  const row = connect != null ? daemons.find((d) => d.daemonId === connect.daemonId) : undefined
  const connected = row?.status === 'online'
  useEffect(() => {
    if (!connect || connected) return
    const id = setInterval(refresh, 3000)
    return () => clearInterval(id)
  }, [connect, connected, refresh])

  const cmds = connect ? daemonCommands(connect.command) : null

  // Bail out before the daemon connects: drop the provisioned-but-never-connected
  // row so it doesn't linger as an offline daemon in the fleet. Once it has
  // connected we keep it (that path shows Done instead of Cancel).
  const cancel = useCallback(async () => {
    // Mid-save the write owns the dialog: dismissing now would strand the error
    // banner a failure needs to render, and let a success chain into Edit agent
    // after the operator asked to leave. The save settles in a moment and closes
    // (or reports) on its own, so Escape is a no-op until then.
    if (cancelling || saving) return
    setCancelling(true)
    dismissed.current = true
    const pending = connect ?? (await provisionPending.current?.catch(() => null))
    if (pending && !connected) {
      try {
        await deleteDaemon(pending.daemonId)
      } catch {
        /* best-effort cleanup — an unclaimed provisioned row is harmless */
      }
    }
    onClose()
  }, [cancelling, saving, connect, connected, deleteDaemon, onClose])

  useEffect(() => registerDismiss(() => void cancel()), [cancel, registerDismiss])

  // Finish: apply the optional name + visibility to the row the daemon just claimed,
  // then close (or chain on). Both writes are skipped when untouched, so the plain
  // "connect and go" path stays a single click. A failure keeps the dialog open —
  // the daemon IS connected either way, so nothing here is worth rolling back.
  const finish = async () => {
    if (saving || !connect) return
    setSaving(true)
    setSaveErr(null)
    try {
      const next = name.trim()
      if (next && next !== row?.name) await renameDaemon(connect.daemonId, next)
      if (retention !== SESSION_RETENTION_DEFAULT) await setDaemonSessionRetention(connect.daemonId, retention)
      if (!sameSharing(sharing, DEFAULT_SHARING)) await saveSharing('daemons', connect.daemonId, sharing)
      // A dialog dismissed while this was in flight must stay dismissed — closing
      // again is harmless, but chaining into Edit agent would reopen a surface the
      // operator already left. (`cancel` fences on `saving`, so this only catches a
      // dismissal that raced the flag; the guard makes the ordering irrelevant.)
      if (dismissed.current) return
      if (onDone) onDone(connect.daemonId)
      else onClose()
    } catch (e) {
      if (dismissed.current) return
      setSaveErr(e instanceof Error ? e.message : String(e))
      setSaving(false)
    }
  }

  return (
    <>
      <div className="modalhead">
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] border border-(--border-subtle) bg-(--surface-sunken)">
          <Icon name="server" size={17} color="var(--brand)" />
        </span>
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">Add daemon</span>
      </div>
      <div className="modalbody">
        <p className="mb-[14px] font-sans text-[13px] font-normal leading-[1.55] text-(--text-secondary)">
          Run one of these commands on the machine where agents should run. AgentConnect installs the daemon
          automatically before connecting it.
        </p>
        <p className="mb-[8px] font-sans text-[12px] font-semibold leading-normal text-(--text-tertiary)">Connect</p>
        <CommandBox
          tabs={[
            { key: 'run', label: 'Run', command: cmds?.run ?? null },
            { key: 'service', label: 'Install as service', command: cmds?.login ?? null }
          ]}
          placeholder={
            err ? (
              <div className="text-(--status-error)">Could not provision a key — {err}</div>
            ) : (
              <div className="text-(--text-inverse-dim)">Minting key…</div>
            )
          }
        />
        <div className="mt-[14px] flex items-center gap-[11px] rounded-[9px] border border-dashed border-(--border-strong) px-[14px] py-[13px]">
          {connected ? (
            <>
              <span className="flex h-[22px] w-[22px] flex-none items-center justify-center rounded-full bg-(--status-online)">
                <Icon name="check" size={13} color="#fff" />
              </span>
              <div className="flex-1">
                <div className="font-sans text-[13px] font-semibold leading-normal">Daemon connected</div>
                <div className="mono text-[11px] text-(--text-tertiary)">{row?.name} is online.</div>
              </div>
            </>
          ) : (
            <>
              <span className="flex-none leading-[0]">
                <Spinner size={22} />
              </span>
              <div className="flex-1">
                <div className="font-sans text-[13px] font-semibold leading-normal">Waiting for daemon…</div>
                <div className="mono text-[11px] text-(--text-tertiary)">It&apos;ll appear here once it connects.</div>
              </div>
            </>
          )}
        </div>
        {/* Both are optional overrides on the row the daemon claims: leave the name
            blank to keep the one it reports (the placeholder, once it has connected),
            and the visibility on Everyone to keep the org-wide default. Written on
            Done (see `finish`). */}
        <div className="fld mt-[14px]">
          <span className="fldlbl">
            Name <span className="font-normal text-(--text-tertiary)">· optional</span>
          </span>
          <input
            className="inp"
            value={name}
            maxLength={64}
            spellCheck={false}
            placeholder={(connected && row?.name) || 'edge-1'}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && connected) void finish()
            }}
          />
        </div>
        <SessionRetentionField value={retention} onChange={setRetention} />
        <VisibilityField value={sharing} onChange={setSharing} />
        {saveErr && (
          <div className="mt-[14px] flex items-start gap-2 rounded-md border border-(--status-error) bg-(--status-error-soft) px-3 py-[11px] font-sans text-[12.5px] font-normal leading-[1.5] text-(--status-error)">
            <Icon name="triangle-alert" size={15} />
            {saveErr}
          </div>
        )}
      </div>
      <div className="modalfoot">
        <span className="mono text-[11px] text-(--text-tertiary)">
          {connect ? 'copy this key now — shown only once' : 'minting key…'}
        </span>
        <div className="flex-1" />
        {connected ? (
          <Button
            variant="primary"
            onClick={() => void finish()}
            className={saving ? 'cursor-default opacity-60' : undefined}
          >
            {saving ? 'Saving…' : onDone ? 'Continue' : 'Done'}
          </Button>
        ) : (
          // Can't finish until the daemon connects — offer a Cancel that cleans up
          // the provisioned row instead.
          <Button
            variant="ghost"
            onClick={() => void cancel()}
            className={cancelling ? 'cursor-default opacity-60' : undefined}
          >
            {cancelling ? 'Cancelling…' : 'Cancel'}
          </Button>
        )}
      </div>
    </>
  )
}
