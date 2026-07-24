// No 'use client' here: rendered only by ModalProvider (the client boundary).

import { useEffect, useRef, useState } from 'react'
import { useConsoleData } from '@/lib/data-context'
import type { DaemonRow } from '@/lib/data'
import type { MintedKeyDto } from '@/lib/api'
import { daemonCommands } from '@/lib/daemon-commands'
import { Button, Icon } from '@/components/ui'
import { Spinner } from '@/components/marks'

// Reconnect an OFFLINE daemon: mint it a fresh key + the same start command as
// first-time connect, shown once. Re-running it on the daemon's host re-auths it
// (the key carries the existing daemonId), so the row flips back to `online`.
export default function ReconnectDaemonModal({ daemon, onClose }: { daemon: DaemonRow; onClose: () => void }) {
  const { reconnectDaemon, daemons, refresh } = useConsoleData()
  const [minted, setMinted] = useState<MintedKeyDto | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const started = useRef(false)

  // Mint exactly one key when the modal opens; the ref guard dedupes StrictMode's
  // double-invoke (see AddDaemonModal for why setState isn't gated on an active flag).
  useEffect(() => {
    if (started.current) return
    started.current = true
    reconnectDaemon(daemon.daemonId)
      .then(setMinted)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
  }, [reconnectDaemon, daemon.daemonId])

  // Poll the fleet until OUR daemon reports `online` again (it re-authenticated).
  const reconnected = minted != null && daemons.some((d) => d.daemonId === daemon.daemonId && d.status === 'online')
  useEffect(() => {
    if (!minted || reconnected) return
    const id = setInterval(refresh, 3000)
    return () => clearInterval(id)
  }, [minted, reconnected, refresh])

  // The daemon is already installed on its host (it was online before), so
  // reconnect is a single `cli run` — no `version install` step. Reuse the CP's
  // minted command, rewritten to the unified CLI.
  const runCommand = minted ? daemonCommands(minted.command).run : null

  const copy = async () => {
    if (!runCommand) return
    try {
      await navigator.clipboard.writeText(runCommand)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable (insecure context) — user can still select the text */
    }
  }

  return (
    <>
      <div className="modalhead">
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] border border-(--border-subtle) bg-(--surface-sunken)">
          <Icon name="refresh-cw" size={16} color="var(--brand)" />
        </span>
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">Reconnect daemon</span>
        <button className="iconbtn" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="modalbody">
        <div className="mb-[14px] flex items-start gap-[9px] rounded-md border border-(--amber-500) bg-(--status-paused-soft) px-3 py-[11px]">
          <Icon name="alert-triangle" size={15} color="var(--amber-500)" className="mt-[1px] flex-none" />
          <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
            This issues a fresh connect token for <span className="mono text-(--text-primary)">{daemon.name}</span>. Run
            the command below on its host to bring it back online — its identity and agents are preserved.
          </span>
        </div>
        <div className="overflow-hidden rounded-[9px] border border-(--gray-800) bg-(--gray-1000)">
          <div className="flex items-center gap-2 border-b border-(--gray-800) px-[13px] py-[9px]">
            <Icon name="terminal" size={13} color="var(--text-inverse-dim)" />
            <span className="font-mono text-[11px] font-medium leading-normal text-(--text-inverse-dim)">
              {daemon.name} · terminal
            </span>
            <button
              type="button"
              onClick={copy}
              disabled={!minted}
              className="ml-auto inline-flex cursor-pointer items-center gap-[5px] border-0 bg-transparent font-mono text-[11px] font-medium leading-normal text-(--text-inverse-dim) disabled:cursor-default disabled:opacity-50"
            >
              <Icon name={copied ? 'check' : 'copy'} size={12} />
              {copied ? 'copied' : 'copy'}
            </button>
          </div>
          <div className="break-all px-[14px] py-[13px] font-mono text-[12px] leading-[1.7] text-[#cdd6e0]">
            {runCommand ? (
              <div>
                <span className="text-(--magenta-300)">$</span> {runCommand}
              </div>
            ) : err ? (
              <div className="text-(--status-error)">Could not mint a key — {err}</div>
            ) : (
              <div className="text-(--text-inverse-dim)">Minting key…</div>
            )}
          </div>
        </div>
        <div className="mt-[14px] flex items-center gap-[11px] rounded-[9px] border border-dashed border-(--border-strong) px-[14px] py-[13px]">
          {reconnected ? (
            <>
              <span className="flex h-[22px] w-[22px] flex-none items-center justify-center rounded-full bg-(--status-online)">
                <Icon name="check" size={13} color="#fff" />
              </span>
              <div className="flex-1">
                <div className="font-sans text-[13px] font-semibold leading-normal">Daemon reconnected</div>
                <div className="mono text-[11px] text-(--text-tertiary)">{daemon.name} is back online.</div>
              </div>
            </>
          ) : (
            <>
              <span className="flex-none leading-[0]">
                <Spinner size={22} />
              </span>
              <div className="flex-1">
                <div className="font-sans text-[13px] font-semibold leading-normal">Waiting for daemon…</div>
                <div className="mono text-[11px] text-(--text-tertiary)">
                  It&apos;ll flip back to online once it re-runs the command.
                </div>
              </div>
            </>
          )}
        </div>
      </div>
      <div className="modalfoot">
        <span className="mono text-[11px] text-(--text-tertiary)">
          {minted ? 'copy this key now — shown only once' : 'minting key…'}
        </span>
        <div className="flex-1" />
        <Button variant={reconnected ? 'primary' : 'ghost'} onClick={onClose}>
          Done
        </Button>
      </div>
    </>
  )
}
