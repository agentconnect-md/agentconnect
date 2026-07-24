// No 'use client' here: rendered only by ModalProvider (the client boundary).

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useConsoleData } from '@/lib/data-context'
import type { DaemonConnectDto } from '@/lib/api'
import { daemonCommands } from '@/lib/daemon-commands'
import { Button, Icon } from '@/components/ui'
import { Spinner } from '@/components/marks'

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

export default function AddDaemonModal({ onClose }: { onClose: () => void }) {
  const { provisionDaemon, daemons, refresh, deleteDaemon } = useConsoleData()
  const [connect, setConnect] = useState<DaemonConnectDto | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const provisioned = useRef(false)

  // Mint a daemon + its API key + start command once when the modal opens. The ref
  // guard dedupes StrictMode's double-invoke so only one key is minted; we
  // deliberately don't gate setState on an "active" flag, because StrictMode's
  // first-pass cleanup would then discard the (only) fetch's result.
  useEffect(() => {
    if (provisioned.current) return
    provisioned.current = true
    provisionDaemon()
      .then(setConnect)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
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
  const cancel = async () => {
    if (cancelling) return
    setCancelling(true)
    if (connect && !connected) {
      try {
        await deleteDaemon(connect.daemonId)
      } catch {
        /* best-effort cleanup — an unclaimed provisioned row is harmless */
      }
    }
    onClose()
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
          Run these on the machine where agents should run — first install the daemon, then connect it to the control
          plane.
        </p>
        <p className="mb-[8px] font-sans text-[12px] font-semibold leading-normal text-(--text-tertiary)">
          1 · Install the daemon
        </p>
        <CommandBox
          tabs={[{ key: 'install', label: 'install', command: cmds?.install ?? null }]}
          placeholder={
            err ? (
              <div className="text-(--status-error)">Could not provision a key — {err}</div>
            ) : (
              <div className="text-(--text-inverse-dim)">Minting key…</div>
            )
          }
        />
        <p className="mb-[8px] mt-[16px] font-sans text-[12px] font-semibold leading-normal text-(--text-tertiary)">
          2 · Connect
        </p>
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
      </div>
      <div className="modalfoot">
        <span className="mono text-[11px] text-(--text-tertiary)">
          {connect ? 'copy this key now — shown only once' : 'minting key…'}
        </span>
        <div className="flex-1" />
        {connected ? (
          <Button variant="primary" onClick={onClose}>
            Done
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
