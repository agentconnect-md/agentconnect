// No 'use client' here: rendered only inside a client boundary (SettingsView).

import { useState } from 'react'
import { Button, Icon } from '@/components/ui'
import { GithubMark } from '@/components/marks'
import { uninstallGithubInstallation, type GithubInstallationDto } from '@/lib/api'

// Confirm the destructive GitHub-side uninstall. The CP asks GitHub to revoke
// the App's repository access, retires its matching local installation, and
// converges the affected hooks. Reinstalling later is still possible.
export default function UninstallGithubInstallationModal({
  installation,
  onClose,
  onUninstalled
}: {
  installation: GithubInstallationDto
  onClose: () => void
  onUninstalled: (id: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const onUninstall = async () => {
    if (busy) return
    setBusy(true)
    setErr(null)
    try {
      await uninstallGithubInstallation(installation.id)
      onUninstalled(installation.id)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <>
      <div className="modalhead">
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--status-error-soft)">
          <span className="flex h-4 w-4 items-center justify-center">
            <GithubMark color="var(--status-error)" />
          </span>
        </span>
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">Uninstall GitHub App</span>
        <button className="iconbtn" onClick={onClose} aria-label="Close">
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="modalbody">
        <p className="m-0 font-sans text-[13.5px] font-normal leading-[1.6] text-(--text-secondary)">
          Uninstall the GitHub App from <span className="mono text-(--text-primary)">{installation.accountLogin}</span>?
          The App will lose access to its repositories. Repository triggers and credential-free clone or push operations
          using this installation will stop working.
        </p>
        <div className="mt-[14px] flex items-start gap-[9px] rounded-md border border-(--border-subtle) bg-(--surface-sunken) px-[13px] py-3">
          <Icon name="info" size={15} color="var(--text-tertiary)" className="mt-[1px] flex-none" />
          <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
            This does not delete repositories or existing sessions. You can install the App again later.
          </span>
        </div>
        {err && (
          <div className="mt-[10px] font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">{err}</div>
        )}
      </div>
      <div className="modalfoot">
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="danger" onClick={onUninstall} className={busy ? 'pointer-events-none opacity-50' : undefined}>
          <Icon name="unplug" size={15} />
          {busy ? 'Uninstalling…' : 'Uninstall'}
        </Button>
      </div>
    </>
  )
}
