// No 'use client' here: rendered only by ModalProvider (the client boundary).

import { useState } from 'react'
import { isCodeHostProvider, type CodeHostProvider } from '@agentconnect.md/protocol/code-host'
import { useConsoleData } from '@/lib/data-context'
import type { HookDto } from '@/lib/api'
import { CODE_HOST_PROJECTION } from '@/lib/code-hosts'
import { giteaFamilyTile, giteaHookFamily } from '@/lib/gitea-events'
import { githubFamilyTile, githubHookFamily } from '@/lib/github-events'
import { gitlabFamilyTile, gitlabHookFamily } from '@/lib/gitlab-events'
import { Button, Icon } from '@/components/ui'

// The subject-family pill a code-host row is named by. Total, so a new host reads as its own
// family instead of as an unnamed row.
const CODE_HOST_FAMILY_PILL: Record<CodeHostProvider, (hook: HookDto) => string | undefined> = {
  github: (h) => {
    const fam = githubHookFamily(h)
    return fam ? githubFamilyTile(fam)?.pill : undefined
  },
  gitlab: (h) => {
    const fam = gitlabHookFamily(h)
    return fam ? gitlabFamilyTile(fam)?.pill : undefined
  },
  gitea: (h) => {
    const fam = giteaHookFamily(h)
    return fam ? giteaFamilyTile(fam)?.pill : undefined
  }
}

// What removing one subscription leaves behind, in each host's own terms.
const CODE_HOST_REMOVAL_NOTE: Record<CodeHostProvider, string> = {
  github: 'those GitHub events are ignored from now on. Past runs and their sessions stay.',
  gitlab:
    'those GitLab events are ignored from now on. The project itself, its bot and its webhook are untouched. Past runs and their sessions stay.',
  gitea:
    'those Gitea events are ignored from now on. The repository itself, its bot and its webhook are untouched. Past runs and their sessions stay.'
}

// Confirm-delete a trigger. The CP drops the row and the relay pool drops its
// rule — a webhook's inbound URL stops accepting deliveries immediately (senders
// get a uniform 404); a github subscription stops matching that repo's events;
// Past runs and their sessions survive. The list re-pulls via the data context.
// a gitlab or gitea subscription stops matching that project's or repository's events.
// An ARRAY target removes a set in one confirm — one repo's whole family set, or every repo; the repos named decide.
export default function DeleteHookModal({ hook, onClose }: { hook: HookDto | HookDto[]; onClose: () => void }) {
  const { deleteHook } = useConsoleData()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const hooks = Array.isArray(hook) ? hook : [hook]
  // A repo watched for two subject families is two rows — name each repo once.
  const repoNames = [...new Set(hooks.map((h) => h.repoFullName ?? h.name))]
  const group = Array.isArray(hook) && repoNames.length > 1
  // A code-host row covers ONE family, so name it: the repo's other families keep firing.
  const familyOf = (h: HookDto) => (isCodeHostProvider(h.kind) ? CODE_HOST_FAMILY_PILL[h.kind](h) : undefined)
  const first = hooks[0]!
  const provider = isCodeHostProvider(first.kind) ? first.kind : null
  // Only a code host's rows group, so the generic endpoint never reads this name.
  const hostName = CODE_HOST_PROJECTION[provider ?? 'github'].label
  // Every family this confirm removes from the one repository it names.
  const familyList = [...new Set(hooks.map(familyOf).filter((pill): pill is string => !!pill))].join(', ')
  const subject = `${first.repoFullName ?? first.name}${familyList ? ` · ${familyList}` : ''}`

  const onDelete = async () => {
    if (busy) return
    setBusy(true)
    setErr(null)
    try {
      for (const h of hooks) await deleteHook(h.id, h.agentId)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <>
      <div className="modalhead">
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--status-error-soft)">
          <Icon name={provider ? 'folder-git-2' : 'webhook'} size={16} color="var(--status-error)" />
        </span>
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">
          {group
            ? `Disconnect ${hostName}`
            : provider
              ? `Remove ${CODE_HOST_PROJECTION[provider].repoNoun}`
              : 'Delete webhook'}
        </span>
        <button className="iconbtn" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="modalbody">
        <p className="m-0 font-sans text-[13.5px] font-normal leading-[1.6] text-(--text-secondary)">
          {group ? (
            <>
              Removes all {repoNames.length} repository subscriptions (
              <span className="mono text-(--text-primary)">{repoNames.join(', ')}</span>) — {hostName} events stop
              triggering this agent. Past runs and their sessions stay.
            </>
          ) : provider ? (
            <>
              <span className="mono text-(--text-primary)">{subject}</span>&#32;stops triggering this agent —{' '}
              {CODE_HOST_REMOVAL_NOTE[provider]}
            </>
          ) : (
            <>
              <span className="mono text-(--text-primary)">{first.name}</span>&#32;will be removed and its inbound URL
              stops accepting deliveries immediately — anything still POSTing it gets a 404. Past runs and their
              sessions stay.
            </>
          )}
        </p>
        {err && (
          <div className="mt-[10px] font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">{err}</div>
        )}
      </div>
      <div className="modalfoot">
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="danger" onClick={onDelete} className={busy ? 'pointer-events-none opacity-50' : undefined}>
          <Icon name={group ? 'unplug' : 'trash'} size={15} />
          {busy ? (group ? 'Disconnecting…' : 'Deleting…') : group ? 'Disconnect' : 'Delete'}
        </Button>
      </div>
    </>
  )
}
