// No 'use client' here: rendered only inside ModalProvider's tree (the client boundary).

import { Icon } from '@/components/ui'
import type { Agent } from '@/lib/data'
import type { WizardHost } from '../contract'
import { useDeploymentConfig } from '../deployment-config'
import { usePublishedFooter } from '../publish'
import { linearApi } from './api'
import { linearConnectAvailability, useLinearConnect } from './connect'
import { LinearMark } from './mark'

/**
 * Linear's pane — "enable this agent on a connected workspace"
 * (linear-integration.md §4.3, §7.1).
 *
 * A Linear Bot row IS one connected workspace, and every agent on it is a member,
 * so the wizard's two modes split differently here than on the other platforms:
 * REUSE is the ordinary path (the host's free-bot list is the org's connected
 * workspaces, and its own footer commits the membership unfenced, §7.4), while
 * CREATE is a hand-off — there is nothing to paste, only an org-level OAuth round
 * trip that mints the workspace bot server-side.
 *
 * The pane commits through its own inline button, like the Feishu deeplink flow, so
 * the host's create primary stays hidden throughout.
 */
export function LinearWizardBody({ agent, host }: { agent: Agent; host: WizardHost }) {
  // The chassis reads this same probe for its relay capability; one SWR key ⇒ one
  // request. Only the "has it answered yet" bit is read here — the VALUE comes off
  // the host, so the two can never disagree about the deployment.
  const probe = useDeploymentConfig(true)
  const { invalidate, close } = host
  const flow = useLinearConnect(
    () => linearApi.startConnect(agent.id),
    () => {
      invalidate()
      close()
    }
  )

  // An answer WINS over a later error: a transient revalidation failure must not
  // retract a relay this pane already learned about (the Slack funnel's rule).
  const relayAvailable: boolean | null = probe.config ? host.relayCapability.available : probe.failed ? false : null
  const availability = linearConnectAvailability({
    relayAvailable,
    appConfigured: flow.appMissing ? false : null
  })

  // The commit is the pane's own button in every state, so the footer primary is
  // suppressed rather than published — reuse mode has the host's own footer.
  usePublishedFooter(host, { label: 'Connect', enabled: false, onSubmit: () => {}, hidden: true })

  if (host.mode === 'existing') {
    return (
      <div className="mb-4 flex items-start gap-[10px] rounded-[9px] border border-(--border-subtle) bg-(--surface-app) p-[14px] font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-tertiary)">
        <Icon name="info" size={15} className="mt-[1px] flex-none" />
        <span>
          {agent.name} joins this workspace as a member. Mention the app on an issue and name it —{' '}
          <span className="mono">@{agent.name}</span>&#32;— to reach it; bare delegations go to the workspace&rsquo;s
          default agent.
        </span>
      </div>
    )
  }

  return (
    <div className="mb-4 rounded-[9px] border border-(--border-subtle) bg-(--surface-app) p-[14px]">
      {availability === 'checking' ? (
        <div className="flex items-center gap-[10px] font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
          <Icon name="loader" size={15} className="flex-none animate-spin" />
          Checking your Linear setup…
        </div>
      ) : availability === 'app_required' ? (
        <div className="flex items-start gap-[10px] font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-tertiary)">
          <Icon name="info" size={15} className="mt-[1px] flex-none" />
          <span>
            Linear isn&rsquo;t set up on this deployment yet. An administrator registers one Linear OAuth application
            for the whole deployment before workspaces can be connected.
          </span>
        </div>
      ) : availability === 'relay_required' ? (
        <div className="flex items-start gap-[10px] font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-tertiary)">
          <Icon name="info" size={15} className="mt-[1px] flex-none" />
          <span>
            Linear delivers over HTTP callbacks only, so it needs a public callback endpoint. Ask an administrator to
            configure one, then connect a workspace here.
          </span>
        </div>
      ) : (
        <>
          <div className="mb-[10px] font-sans text-[12.5px] font-medium leading-[1.45] text-(--text-secondary)">
            Connect a Linear workspace. {agent.name} becomes its default agent — the one a bare delegation starts a
            session with.
          </div>
          {flow.phase === 'authorizing' ? (
            <div className="flex h-[46px] w-full items-center justify-center gap-[10px] rounded-[10px] bg-(--surface-inverse) font-sans text-[14px] font-semibold leading-normal text-white opacity-85">
              <Icon name="loader" size={16} className="flex-none animate-spin" />
              Waiting for Linear…
            </div>
          ) : (
            <button
              type="button"
              onClick={flow.start}
              className="flex h-[46px] w-full cursor-pointer items-center justify-center gap-[10px] rounded-[10px] border-0 bg-(--surface-inverse) font-sans text-[14px] font-semibold leading-normal text-white"
            >
              <span className="imark h-[18px] w-[18px] border-0 bg-transparent">
                <LinearMark fillPct={100} />
              </span>
              Connect Linear
            </button>
          )}
          {flow.err && (
            <div className="mt-2 font-sans text-[11.5px] font-normal leading-[1.4] text-(--status-error)">
              {flow.err}
            </div>
          )}
          <div className="mt-[10px] font-sans text-[12px] font-normal leading-[1.4] text-(--text-tertiary)">
            {flow.phase === 'authorizing'
              ? 'Approve the workspace in the Linear tab — this closes automatically once it lands.'
              : 'Other agents join the same workspace later from their own Add integration.'}
          </div>
        </>
      )}
    </div>
  )
}
