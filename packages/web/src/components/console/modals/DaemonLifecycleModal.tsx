// No 'use client' here: rendered only by ModalProvider (the client boundary).

import { useEffect, useState } from 'react'
import { useConsoleData } from '@/lib/data-context'
import { getDaemonLifecycleOp, type DaemonLifecycleOpDto } from '@/lib/api'
import type { DaemonRow } from '@/lib/data'
import { Button, Icon } from '@/components/ui'
import { Spinner } from '@/components/marks'

// Command a live daemon to restart (drain + relaunch, same version) or upgrade (install
// a target version via its CLI, then relaunch onto it). The command only means the daemon
// ACCEPTED it; the real outcome is closed out-of-band when the daemon relaunches and
// re-registers READY. We capture the opened op's `id` from the POST, then poll the fleet
// for THAT op's terminal `status` — never inferring success from a disappearing pending
// op (which is ambiguous: a timeout also clears it, and a fast restart can complete before
// the first poll). cli-daemon-split.md §7.
export default function DaemonLifecycleModal({
  daemon,
  mode,
  onClose
}: {
  daemon: DaemonRow
  mode: 'upgrade' | 'restart'
  onClose: () => void
}) {
  const { upgradeDaemon, restartDaemon, daemons, refresh } = useConsoleData()

  // Upgrade targets: published versions other than the one already running.
  const options = mode === 'upgrade' ? daemon.availableVersions.filter((v) => v !== daemon.version) : []
  const [version, setVersion] = useState(() =>
    daemon.latestVersion && options.includes(daemon.latestVersion) ? daemon.latestVersion : (options[0] ?? '')
  )
  const [busy, setBusy] = useState(false)
  // The op WE commanded, tracked by id via a dedicated poll — NOT the fleet read model's
  // single latest-op slot (a newer op from another client would strand our tracking).
  const [tracked, setTracked] = useState<DaemonLifecycleOpDto | null>(null)
  // The op row vanished mid-poll (404 → null): e.g. another owner deleted the offline
  // daemon during restart, cascading the row. A TERMINAL state — stop polling, don't spin.
  const [gone, setGone] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const opId = tracked?.id ?? null
  const terminal = gone || tracked?.status === 'succeeded' || tracked?.status === 'failed'
  const live = daemons.find((d) => d.daemonId === daemon.daemonId)

  // Poll our op by id while it is in flight (accepted, not yet terminal). Also refresh the
  // fleet so the detail-view badge tracks alongside; a transient fetch error just retries,
  // but a definitive 404 (null) is terminal (the op no longer exists).
  useEffect(() => {
    if (!opId || terminal) return
    let cancelled = false
    const poll = async () => {
      try {
        const op = await getDaemonLifecycleOp(daemon.daemonId, opId)
        if (cancelled) return
        if (op) setTracked(op)
        else setGone(true) // 404 — the op (or its daemon) is gone; stop polling
        refresh()
      } catch {
        /* transient network/5xx — retry on the next tick */
      }
    }
    const timer = setInterval(poll, 3000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [opId, terminal, daemon.daemonId, refresh])

  const submit = async () => {
    if (busy || opId) return
    if (mode === 'upgrade' && !version) return
    setBusy(true)
    setErr(null)
    try {
      const op =
        mode === 'upgrade' ? await upgradeDaemon(daemon.daemonId, version) : await restartDaemon(daemon.daemonId)
      setTracked(op) // may already be terminal (fast restart settled during the ACK)
      refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const isUpgrade = mode === 'upgrade'
  const title = isUpgrade ? 'Upgrade daemon' : 'Restart daemon'
  const icon = isUpgrade ? 'arrow-up-circle' : 'refresh-cw'
  const noTargets = isUpgrade && options.length === 0
  const succeeded = !gone && tracked?.status === 'succeeded'
  const failed = gone || tracked?.status === 'failed'

  return (
    <>
      <div className="modalhead">
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] border border-(--border-subtle) bg-(--surface-sunken)">
          <Icon name={icon} size={16} color="var(--brand)" />
        </span>
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">{title}</span>
        <button className="iconbtn" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="modalbody">
        {!opId ? (
          <>
            <div className="mb-[14px] flex items-start gap-[9px] rounded-md border border-(--amber-500) bg-(--status-paused-soft) px-3 py-[11px]">
              <Icon name="alert-triangle" size={15} color="var(--amber-500)" className="mt-[1px] flex-none" />
              <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
                {isUpgrade ? (
                  <>
                    <span className="mono text-(--text-primary)">{daemon.name}</span> will install the target version,
                    then drain its active sessions and relaunch onto it. Established sessions finish first; brief
                    downtime during the relaunch.
                  </>
                ) : (
                  <>
                    <span className="mono text-(--text-primary)">{daemon.name}</span> will drain its active sessions and
                    relaunch on the same version. Established sessions finish first; brief downtime during the relaunch.
                  </>
                )}
              </span>
            </div>
            {isUpgrade &&
              (noTargets ? (
                <div className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-tertiary)">
                  No other published versions are available to upgrade to (currently on{' '}
                  <span className="mono text-(--text-secondary)">{daemon.version}</span>).
                </div>
              ) : (
                <div className="fld">
                  <span className="fldlbl">Target version</span>
                  <div className="inp relative">
                    <span className="mono truncate text-[12.5px] text-(--text-primary)">{version}</span>
                    <Icon name="chevron-down" size={15} color="var(--text-tertiary)" className="ml-auto" />
                    <select
                      value={version}
                      onChange={(e) => setVersion(e.target.value)}
                      className="absolute inset-0 cursor-pointer opacity-0"
                      aria-label="Target version"
                    >
                      {options.map((v) => (
                        <option key={v} value={v}>
                          {v}
                          {v === daemon.latestVersion ? ` (latest ${daemon.releaseChannel})` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              ))}
          </>
        ) : (
          <div className="flex items-center gap-[11px] rounded-[9px] border border-dashed border-(--border-strong) px-[14px] py-[13px]">
            {succeeded ? (
              <>
                <span className="flex h-[22px] w-[22px] flex-none items-center justify-center rounded-full bg-(--status-online)">
                  <Icon name="check" size={13} color="#fff" />
                </span>
                <div className="flex-1">
                  <div className="font-sans text-[13px] font-semibold leading-normal">
                    {isUpgrade ? 'Daemon upgraded' : 'Daemon restarted'}
                  </div>
                  <div className="mono text-[11px] text-(--text-tertiary)">
                    {daemon.name} is back online{isUpgrade ? ` on ${live?.version ?? version}` : ''}.
                  </div>
                </div>
              </>
            ) : failed ? (
              <>
                <span className="flex h-[22px] w-[22px] flex-none items-center justify-center rounded-full bg-(--status-error-soft)">
                  <Icon name="alert-triangle" size={13} color="var(--status-error)" />
                </span>
                <div className="flex-1">
                  <div className="font-sans text-[13px] font-semibold leading-normal">
                    {gone ? 'Operation no longer available' : isUpgrade ? 'Upgrade failed' : 'Restart failed'}
                  </div>
                  <div className="mono text-[11px] text-(--text-tertiary)">
                    {gone
                      ? `The operation for ${daemon.name} is gone — the daemon may have been removed.`
                      : (tracked?.outcome ?? `${daemon.name} did not come back as expected.`)}
                  </div>
                </div>
              </>
            ) : (
              <>
                <span className="flex-none leading-[0]">
                  <Spinner size={22} />
                </span>
                <div className="flex-1">
                  <div className="font-sans text-[13px] font-semibold leading-normal">
                    {isUpgrade ? 'Installing and relaunching…' : 'Draining and relaunching…'}
                  </div>
                  <div className="mono text-[11px] text-(--text-tertiary)">
                    {daemon.name} will re-register once its supervisor brings it back.
                  </div>
                </div>
              </>
            )}
          </div>
        )}
        {err && (
          <div className="mt-[10px] font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">{err}</div>
        )}
      </div>
      <div className="modalfoot">
        <div className="flex-1" />
        {opId ? (
          <Button variant={terminal ? 'primary' : 'ghost'} onClick={onClose}>
            {terminal ? 'Done' : 'Close'}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={submit}
              className={busy || noTargets || (isUpgrade && !version) ? 'pointer-events-none opacity-50' : undefined}
            >
              <Icon name={icon} size={15} />
              {busy ? 'Sending…' : isUpgrade ? 'Upgrade' : 'Restart'}
            </Button>
          </>
        )}
      </div>
    </>
  )
}
