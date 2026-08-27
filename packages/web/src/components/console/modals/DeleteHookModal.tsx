// No 'use client' here: rendered only by ModalProvider (the client boundary).

import { useState } from 'react'
import { useConsoleData } from '@/lib/data-context'
import type { HookDto } from '@/lib/api'
import { githubFamilyTile, githubHookFamily } from '@/lib/github-events'
import { gitlabFamilyTile, gitlabHookFamily } from '@/lib/gitlab-events'
import { Button, Icon } from '@/components/ui'

// Confirm-delete a trigger. The CP drops the row and the relay pool drops its
// rule — a webhook's inbound URL stops accepting deliveries immediately (senders
// get a uniform 404); a github subscription stops matching that repo's events;
// Past runs and their sessions survive. The list re-pulls via the data context.
// a gitlab subscription stops matching that project's events.
// An ARRAY target = the GitHub group card's header unplug: disconnect GitHub by
// removing every repo subscription of this agent in one confirm.
export default function DeleteHookModal({ hook, onClose }: { hook: HookDto | HookDto[]; onClose: () => void }) {
  const { deleteHook } = useConsoleData()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const hooks = Array.isArray(hook) ? hook : [hook]
  const group = Array.isArray(hook)
  // A repo watched for two subject families is two rows — name each repo once.
  const repoNames = [...new Set(hooks.map((h) => h.repoFullName ?? h.name))]
  // A code-host row covers ONE family, so name it: the repo's other families keep firing.
  const familyOf = (h: HookDto) => {
    if (h.kind === 'gitlab') {
      const fam = gitlabHookFamily(h)
      return fam ? gitlabFamilyTile(fam)?.pill : undefined
    }
    if (h.kind === 'github') {
      const fam = githubHookFamily(h)
      return fam ? githubFamilyTile(fam)?.pill : undefined
    }
    return undefined
  }
  const first = hooks[0]!
  const isGithub = group || first.kind === 'github'
  const isGitlab = !group && first.kind === 'gitlab'

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
          <Icon name={isGithub || isGitlab ? 'folder-git-2' : 'webhook'} size={16} color="var(--status-error)" />
        </span>
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">
          {group
            ? 'Disconnect GitHub'
            : isGithub
              ? 'Remove repository'
              : isGitlab
                ? 'Remove project'
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
              Removes {repoNames.length === 1 ? 'the' : `all ${repoNames.length}`} repository subscription
              {repoNames.length === 1 ? '' : 's'} (
              <span className="mono text-(--text-primary)">{repoNames.join(', ')}</span>) — GitHub events stop
              triggering this agent. Past runs and their sessions stay.
            </>
          ) : isGithub ? (
            <>
              <span className="mono text-(--text-primary)">
                {first.repoFullName ?? first.name}
                {familyOf(first) ? ` · ${familyOf(first)}` : ''}
              </span>
              &#32;stops triggering this agent — those GitHub events are ignored from now on. Past runs and their
              sessions stay.
            </>
          ) : isGitlab ? (
            <>
              <span className="mono text-(--text-primary)">
                {first.repoFullName ?? first.name}
                {familyOf(first) ? ` · ${familyOf(first)}` : ''}
              </span>
              &#32;stops triggering this agent — those GitLab events are ignored from now on. The project itself, its
              bot and its webhook are untouched. Past runs and their sessions stay.
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
          <Icon name={group ? 'unplug' : 'trash-2'} size={15} />
          {busy ? (group ? 'Disconnecting…' : 'Deleting…') : group ? 'Disconnect' : 'Delete'}
        </Button>
      </div>
    </>
  )
}
