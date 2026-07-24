'use client'

import { useState } from 'react'
import ApiKeysCard from '@/components/console/ApiKeysCard'
import { Button, Icon } from '@/components/ui'
import { API_EVENTS, MOCK_MODE, pgPrompts } from '@/lib/data'
import { cpRestBase, type OrgDto } from '@/lib/api'
import { agentApiRelayUrl, agentApiSnippet, agentApiUrls } from '@/lib/agent-api'
import { useOrgs } from '@/lib/org-context'

type CopyTarget = 'mint' | 'socket' | 'snippet'

const MOCK_ORG: OrgDto = {
  id: 'mock-org',
  name: 'Demo organization',
  slug: '-',
  icon: null,
  iconUrl: null,
  iconUploadEnabled: false,
  role: 'owner',
  memberCount: 1,
  createdAt: '2026-01-01T00:00:00.000Z'
}
const MOCK_RELAY_URL = 'https://relay.example.test'

export function AgentApiPanel({ agentId, agentName }: { agentId: string; agentName: string }) {
  const { activeOrg, error: orgError } = useOrgs()
  const [copied, setCopied] = useState<CopyTarget | null>(null)
  const apiOrg = activeOrg ?? (MOCK_MODE ? MOCK_ORG : null)

  if (!apiOrg) {
    return (
      <div
        className={`p-4 font-sans text-[13px] font-normal leading-normal desktop:p-0 ${
          orgError ? 'text-(--status-error)' : 'text-(--text-tertiary)'
        }`}
      >
        {orgError ? 'Couldn’t load the organization required for API access.' : 'Loading API configuration…'}
      </div>
    )
  }

  const relayUrl = MOCK_MODE ? MOCK_RELAY_URL : agentApiRelayUrl()
  const { mintUrl, socketTemplate } = agentApiUrls(cpRestBase(), apiOrg.id, agentId, relayUrl)
  const socketDisplay = socketTemplate ?? 'Relay endpoint not configured'
  const snippet = agentApiSnippet(mintUrl, pgPrompts(agentId)[0]!)
  const copy = async (target: CopyTarget, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(target)
      setTimeout(() => setCopied(null), 1600)
    } catch {
      /* Insecure contexts may deny clipboard access; the text remains selectable. */
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4 desktop:max-w-[820px] desktop:p-0">
      <p className="m-0 font-sans text-[13px] font-normal leading-[1.6] text-(--text-secondary)">
        Build services on top of <span className="font-semibold text-(--text-primary)">{agentName}</span>. Mint
        short-lived connection credentials, then stream a run directly through the relay — with the same model, tools
        and workspace used by channel conversations.
      </p>

      <ApiKeysCard
        orgs={[apiOrg]}
        defaultOrgId={apiOrg.id}
        scopeOrgId={apiOrg.id}
        defaultName={`${agentName} API`}
        embedded
        title="Authentication"
        description={`Use a personal API key for ${apiOrg.name ?? apiOrg.slug}. It acts as you in this organization and is shown only once when created.`}
      />

      <div className="card overflow-hidden max-desktop:rounded-lg">
        <div className="flex items-center justify-between gap-2 border-b border-(--border-subtle) px-4 py-3 desktop:py-[13px]">
          <span className="inline-flex items-center gap-2 desktop:gap-[9px]">
            <Icon name="webhook" size={16} color="var(--text-tertiary)" />
            <span className="font-sans text-[14px] font-semibold leading-normal">Connection endpoints</span>
          </span>
          <span className="mono text-[11px] text-(--text-tertiary)">streaming</span>
        </div>
        <div className="flex flex-col gap-[10px] px-4 py-[14px]">
          <div className="endpoint">
            <span className="tagpill bg-(--brand-soft) text-(--brand-soft-text)">POST</span>
            <span className="mono flex-1 truncate text-[12px] text-(--text-primary) desktop:text-[12.5px]">
              {mintUrl}
            </span>
            <button
              className="iconbtn h-7 w-7"
              title={copied === 'mint' ? 'Copied' : 'Copy mint endpoint'}
              aria-label={copied === 'mint' ? 'Mint endpoint copied' : 'Copy mint endpoint'}
              onClick={() => void copy('mint', mintUrl)}
            >
              <Icon name={copied === 'mint' ? 'check' : 'copy'} size={14} />
            </button>
          </div>
          <div className="endpoint">
            <span className="tagpill">WSS</span>
            <span
              className={`mono flex-1 truncate text-[12px] desktop:text-[12.5px] ${
                socketTemplate ? 'text-(--text-primary)' : 'text-(--text-tertiary)'
              }`}
              title={socketTemplate ?? undefined}
            >
              {socketDisplay}
            </span>
            {socketTemplate && (
              <button
                className="iconbtn h-7 w-7"
                title={copied === 'socket' ? 'Copied' : 'Copy WebSocket endpoint'}
                aria-label={copied === 'socket' ? 'WebSocket endpoint copied' : 'Copy WebSocket endpoint'}
                onClick={() => void copy('socket', socketTemplate)}
              >
                <Icon name={copied === 'socket' ? 'check' : 'copy'} size={14} />
              </button>
            )}
          </div>
          <p className="m-0 font-sans text-[12px] font-normal leading-[1.55] text-(--text-tertiary)">
            The POST only mints short-lived connection credentials and returns a conversation ID for reconnect or
            resume. It does not create an agent session; the daemon creates one only after it accepts the first message.
          </p>
        </div>
      </div>

      <div className="card overflow-hidden max-desktop:rounded-lg">
        <div className="flex items-center justify-between gap-2 border-b border-(--border-subtle) px-4 py-3 desktop:py-[13px]">
          <span className="inline-flex items-center gap-2 desktop:gap-[9px]">
            <Icon name="code-xml" size={16} color="var(--text-tertiary)" />
            <span className="font-sans text-[14px] font-semibold leading-normal">Connect</span>
          </span>
          <Button variant="ghost" size="xs" onClick={() => void copy('snippet', snippet)}>
            <Icon name={copied === 'snippet' ? 'check' : 'copy'} size={13} />
            {copied === 'snippet' ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <div className="px-4 py-[14px]">
          <div className="codedark">{snippet}</div>
        </div>
      </div>

      <div className="card overflow-hidden max-desktop:rounded-lg">
        <div className="flex items-center justify-between gap-2 border-b border-(--border-subtle) px-4 py-3 desktop:py-[13px]">
          <span className="inline-flex items-center gap-2 desktop:gap-[9px]">
            <Icon name="radio" size={16} color="var(--text-tertiary)" />
            <span className="font-sans text-[14px] font-semibold leading-normal">Stream events</span>
          </span>
          <span className="mono text-[11px] text-(--text-tertiary)">server → client</span>
        </div>
        {API_EVENTS.map((event) => (
          <div
            key={event.name}
            className="flex flex-col gap-1 border-t border-(--border-subtle) px-4 py-[11px] first:border-t-0 desktop:grid desktop:grid-cols-[150px_1fr] desktop:items-baseline desktop:gap-[14px] desktop:py-3"
          >
            <span className="mono text-[12px] text-(--brand-soft-text)">{event.name}</span>
            <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
              {event.desc}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
