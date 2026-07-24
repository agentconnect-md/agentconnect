// No 'use client' here: rendered only inside a client boundary (Shell).

// "Connect your AI" (agent-assistant.md §6, P1) — opened from the rail-footer
// help menu. Points an external MCP client (claude.ai custom connector, Claude
// Code, any MCP-capable tool) at the AgentConnect MCP endpoint. The endpoint is
// deployment-wide; the credential is personal — browser OAuth sign-in, or a
// personal API key from the Profile page — so a connected AI acts with the
// signed-in user's own permissions. "More" jumps to the external connector docs
// (the deploy-overridable HELP_MCP_URL target, passed in by the shell).

import { useEffect, useState } from 'react'
import { Icon } from '@/components/ui'
import { cpRestBase } from '@/lib/api'

// The public MCP endpoint: a dedicated origin when the deploy sets MCP_URL
// (mirrors the CP's PUBLIC_MCP_URL, injected via window.__AC_ENV), else the
// CP REST base + /mcp.
function mcpEndpointUrl(): string {
  const dedicated = typeof window !== 'undefined' ? window.__AC_ENV?.MCP_URL : process.env.MCP_URL
  return (dedicated || `${cpRestBase()}/mcp`).replace(/\/+$/, '')
}

type CopyTarget = 'url' | 'cli'

export default function ConnectAiModal({ onClose, moreUrl }: { onClose: () => void; moreUrl: string }) {
  const [copied, setCopied] = useState<CopyTarget | null>(null)
  const url = mcpEndpointUrl()
  const cli = `claude mcp add --transport http agentconnect ${url}`

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

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
    <div className="scrim" onClick={onClose}>
      <div className="modal max-w-[520px]" onClick={(e) => e.stopPropagation()}>
        <div className="modalhead">
          <Icon name="plug" size={18} color="var(--text-tertiary)" />
          <span className="font-sans text-[15px] font-semibold leading-normal">Connect your AI</span>
        </div>
        <div className="modalbody flex flex-col gap-[10px]">
          <p className="m-0 font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-secondary)">
            Give claude.ai, Claude Code or any MCP client a live view of this workspace — agents, sessions, schedules,
            usage — plus guarded write tools. It connects as <em>you</em>: everything it can see or touch is bounded by
            your own role and permissions.
          </p>

          <div className="endpoint">
            <span className="tagpill bg-(--brand-soft) text-(--brand-soft-text)">MCP</span>
            <span className="mono flex-1 truncate text-[12px] text-(--text-primary) desktop:text-[12.5px]">{url}</span>
            <button
              className="iconbtn h-7 w-7"
              title={copied === 'url' ? 'Copied' : 'Copy MCP endpoint'}
              aria-label={copied === 'url' ? 'MCP endpoint copied' : 'Copy MCP endpoint'}
              onClick={() => void copy('url', url)}
            >
              <Icon name={copied === 'url' ? 'check' : 'copy'} size={14} />
            </button>
          </div>

          <div className="flex flex-col gap-1">
            <span className="font-sans text-[12px] font-semibold leading-normal text-(--text-primary)">claude.ai</span>
            <p className="m-0 font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-secondary)">
              Settings → Connectors → <span className="font-medium">Add custom connector</span> → paste the URL above.
              The browser sign-in asks which organization to connect and whether to allow read-only or read + write
              access.
            </p>
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <span className="font-sans text-[12px] font-semibold leading-normal text-(--text-primary)">
                Claude Code
              </span>
              <button
                className="iconbtn h-7 w-7"
                title={copied === 'cli' ? 'Copied' : 'Copy command'}
                aria-label={copied === 'cli' ? 'Command copied' : 'Copy command'}
                onClick={() => void copy('cli', cli)}
              >
                <Icon name={copied === 'cli' ? 'check' : 'copy'} size={14} />
              </button>
            </div>
            <div className="codedark break-all">{cli}</div>
            <p className="m-0 font-sans text-[12px] font-normal leading-[1.55] text-(--text-tertiary)">
              Then run <span className="mono">/mcp</span> to sign in via the browser. Headless clients can skip OAuth by
              sending a personal API key (Profile → API keys) as an{' '}
              <span className="mono">Authorization: Bearer &lt;key&gt;</span> header — a key carries your full
              permissions.
            </p>
          </div>

          <a
            className="lnk inline-flex items-center gap-[5px] self-start font-sans text-[12.5px] font-medium leading-normal"
            href={moreUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            More
            <Icon name="arrow-up-right" size={13} />
          </a>
        </div>
      </div>
    </div>
  )
}
