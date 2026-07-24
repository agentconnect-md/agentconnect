'use client'

// The "Add …" dialogs are self-contained (data context + onClose, no navigation),
// so the simplest home for them is a provider: views call openModal(kind); the host
// JSX lives here, mounted once by the console shell. The scoped dialogs take a target
// via openModal's 2nd arg — a DaemonRow (reconnect / delete daemon) or an Agent
// (add integration / delete / edit agent); the kind selects which the render casts it to.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Agent, DaemonRow, IntegrationRow } from '@/lib/data'
import type { CronDto, HookDto } from '@/lib/api'
import AddAgentModal from './modals/AddAgentModal'
import AddDaemonModal from './modals/AddDaemonModal'
import AddIntegrationModal, { type Platform as IntegrationPlatform } from './modals/AddIntegrationModal'
import DeleteIntegrationModal from './modals/DeleteIntegrationModal'
import DeleteHookModal from './modals/DeleteHookModal'
import AddCronModal from './modals/AddCronModal'
import ReconnectDaemonModal from './modals/ReconnectDaemonModal'
import DeleteDaemonModal from './modals/DeleteDaemonModal'
import DaemonLifecycleModal from './modals/DaemonLifecycleModal'
import EditDaemonModal from './modals/EditDaemonModal'
import DeleteAgentModal from './modals/DeleteAgentModal'
import EditAgentModal, { type EditAgentSection } from './modals/EditAgentModal'
import EditDescriptionModal from './modals/EditDescriptionModal'
import EditProfileModal from './modals/EditProfileModal'
import CreateOrgModal from './modals/CreateOrgModal'
import EditOrgModal from './modals/EditOrgModal'

export type ModalKind =
  | 'agent'
  | 'daemon'
  | 'integration'
  | 'deleteIntegration'
  | 'deleteHook'
  | 'cron'
  | 'reconnectDaemon'
  | 'deleteDaemon'
  | 'upgradeDaemon'
  | 'restartDaemon'
  | 'editDaemon'
  | 'deleteAgent'
  | 'editAgent'
  | 'editAgentDesc'
  | 'editProfile'
  | 'createOrg'
  | 'editOrg'

// HookDto[] = the whole GitHub group (header unplug — disconnect every repo subscription).
type ModalTarget = DaemonRow | Agent | CronDto | IntegrationRow | HookDto | HookDto[]

// Per-kind extras: `platform` preselects the Add-integration pane (the GitHub group
// card's "Add repository" lands on GitHub, not the Slack default). `focusSection`
// scrolls the Edit-agent modal to the group whose Edit was clicked (Basics / Runtime
// behavior / Access), so every Configuration group edits through the same surface.
interface ModalOpts {
  platform?: IntegrationPlatform
  focusSection?: EditAgentSection
}

interface ModalData {
  // `target` is the scoped dialog's subject (DaemonRow or Agent); ignored by the rest.
  openModal: (kind: ModalKind, target?: ModalTarget, opts?: ModalOpts) => void
}

const Ctx = createContext<ModalData | null>(null)

export function ModalProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<{ kind: ModalKind; target?: ModalTarget; opts?: ModalOpts } | null>(null)
  const openModal = useCallback(
    (kind: ModalKind, target?: ModalTarget, opts?: ModalOpts) => setOpen({ kind, target, opts }),
    []
  )
  const close = useCallback(() => setOpen(null), [])

  const value = useMemo<ModalData>(() => ({ openModal }), [openModal])

  // Dialogs hold in-progress form state, so a stray click on the scrim must not
  // discard it — only Esc (or the explicit Cancel / ×) closes.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  return (
    <Ctx.Provider value={value}>
      {children}
      {open && (
        <div className="scrim">
          <div
            className={
              open.kind === 'integration'
                ? 'modal desktop:max-w-[700px]'
                : // Add/Edit agent carry a section rail beside the form — they need the
                  // design's ≥720px so the two-up fields keep their old width.
                  open.kind === 'agent' || open.kind === 'editAgent'
                  ? 'modal desktop:max-w-[760px]'
                  : 'modal'
            }
          >
            {open.kind === 'agent' && <AddAgentModal onClose={close} />}
            {open.kind === 'daemon' && <AddDaemonModal onClose={close} />}
            {open.kind === 'integration' && open.target && (
              <AddIntegrationModal agent={open.target as Agent} initialPlatform={open.opts?.platform} onClose={close} />
            )}
            {open.kind === 'deleteIntegration' && open.target && (
              <DeleteIntegrationModal integration={open.target as IntegrationRow} onClose={close} />
            )}
            {open.kind === 'deleteHook' && open.target && (
              <DeleteHookModal hook={open.target as HookDto | HookDto[]} onClose={close} />
            )}
            {open.kind === 'cron' && <AddCronModal cron={open.target as CronDto | undefined} onClose={close} />}
            {open.kind === 'reconnectDaemon' && open.target && (
              <ReconnectDaemonModal daemon={open.target as DaemonRow} onClose={close} />
            )}
            {open.kind === 'deleteDaemon' && open.target && (
              <DeleteDaemonModal daemon={open.target as DaemonRow} onClose={close} />
            )}
            {open.kind === 'upgradeDaemon' && open.target && (
              <DaemonLifecycleModal daemon={open.target as DaemonRow} mode="upgrade" onClose={close} />
            )}
            {open.kind === 'restartDaemon' && open.target && (
              <DaemonLifecycleModal daemon={open.target as DaemonRow} mode="restart" onClose={close} />
            )}
            {open.kind === 'editDaemon' && open.target && (
              <EditDaemonModal daemon={open.target as DaemonRow} onClose={close} />
            )}
            {open.kind === 'deleteAgent' && open.target && (
              <DeleteAgentModal agent={open.target as Agent} onClose={close} />
            )}
            {open.kind === 'editAgent' && open.target && (
              <EditAgentModal agent={open.target as Agent} focusSection={open.opts?.focusSection} onClose={close} />
            )}
            {open.kind === 'editAgentDesc' && open.target && (
              <EditDescriptionModal agent={open.target as Agent} onClose={close} />
            )}
            {open.kind === 'editProfile' && <EditProfileModal onClose={close} />}
            {open.kind === 'createOrg' && <CreateOrgModal onClose={close} />}
            {open.kind === 'editOrg' && <EditOrgModal onClose={close} />}
          </div>
        </div>
      )}
    </Ctx.Provider>
  )
}

export function useModal(): ModalData {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useModal must be used within <ModalProvider>')
  return ctx
}
