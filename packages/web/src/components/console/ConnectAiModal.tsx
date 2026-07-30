// No 'use client' here: rendered only inside a client boundary (Shell).

// "Connect your AI" (agent-assistant.md §6, P1) — opened from the rail-footer
// help menu. Points an external MCP client (claude.ai custom connector, Claude
// Code, any MCP-capable tool) at the AgentConnect MCP endpoint. The endpoint is
// deployment-wide; the credential is personal — browser OAuth sign-in, or a
// personal API key from the Profile page — so a connected AI acts with the
// signed-in user's own permissions. The docs link jumps to the external
// connector docs (the deploy-overridable HELP_MCP_URL target, passed in by the
// shell) rather than the design's hard-coded modelcontextprotocol.io URL.

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

const TAGLINE = 'Connects as you — your role, your permissions'

type CopyTarget = 'url' | 'cli'

export default function ConnectAiModal({ onClose, moreUrl }: { onClose: () => void; moreUrl: string }) {
  const [copied, setCopied] = useState<CopyTarget | null>(null)
  const [keyOpen, setKeyOpen] = useState(false)
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
      <div className="modal max-w-[600px]" onClick={(e) => e.stopPropagation()}>
        <div className="modalhead">
          <Icon name="plug" size={20} color="var(--text-secondary)" />
          <span className="font-sans text-[17px] font-semibold tracking-[-0.012em] leading-normal">
            Connect your AI
          </span>
          {/* The tagline replaces the old intro paragraph, so mobile — where it
              would never fit beside the title — carries it in the body instead. */}
          <span className="ml-auto hidden font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary) desktop:block">
            {TAGLINE}
          </span>
          <button type="button" className="iconbtn ml-auto desktop:ml-[6px]" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="modalbody flex flex-col">
          <p className="m-0 pb-[14px] font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary) desktop:hidden">
            {TAGLINE}
          </p>

          <div className="flex flex-col gap-[7px] pb-[18px]">
            <span className="font-mono text-[11px] font-semibold tracking-[0.08em] uppercase leading-normal text-(--text-tertiary)">
              MCP server URL
            </span>
            <div className="flex items-center gap-3 rounded-md border border-(--border-default) bg-(--surface-sunken) py-3 pr-3 pl-[14px]">
              <span className="mono min-w-0 flex-1 truncate text-[13px] tracking-[-0.01em] text-(--text-primary) desktop:text-[14px]">
                {url}
              </span>
              <button
                type="button"
                className="iconbtn h-[30px] w-auto gap-[6px] px-[10px] font-sans text-[12px] font-medium leading-normal"
                onClick={() => void copy('url', url)}
              >
                <Icon name={copied === 'url' ? 'check' : 'copy'} size={14} />
                {copied === 'url' ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 items-start gap-y-[7px] border-t border-(--border-subtle) py-4 desktop:grid-cols-[128px_1fr] desktop:gap-x-4">
            <span className="font-sans text-[13px] font-semibold leading-[1.4] text-(--text-primary)">
              Claude Desktop &amp; claude.ai
            </span>
            <div className="flex flex-col gap-[7px]">
              <span className="font-sans text-[13.5px] font-normal leading-normal text-(--text-secondary)">
                Settings → Connectors →&#32;
                <strong className="font-semibold text-(--text-primary)">Add custom connector</strong>
              </span>
              <span className="font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
                Sign-in picks the org and access level
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 items-start gap-y-[7px] border-t border-(--border-subtle) py-4 desktop:grid-cols-[128px_1fr] desktop:gap-x-4">
            <span className="font-sans text-[13px] font-semibold leading-normal text-(--text-primary) desktop:pt-[7px]">
              Claude Code
            </span>
            <div className="flex flex-col gap-[7px]">
              <div className="relative">
                <div className="codedark pr-11">{cli}</div>
                <button
                  type="button"
                  className="absolute top-2 right-2 flex h-[26px] w-[26px] cursor-pointer items-center justify-center rounded-[5px] border border-white/15 bg-white/5 text-[#c9cfd8] transition-colors hover:bg-white/10"
                  title={copied === 'cli' ? 'Copied' : 'Copy command'}
                  aria-label={copied === 'cli' ? 'Command copied' : 'Copy command'}
                  onClick={() => void copy('cli', cli)}
                >
                  <Icon name={copied === 'cli' ? 'check' : 'copy'} size={13} />
                </button>
              </div>
              <span className="font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
                Then <span className="mono text-[12px] text-(--text-secondary)">/mcp</span> to sign in
              </span>
            </div>
          </div>

          <div className="flex items-center gap-4 border-t border-(--border-subtle) pt-[15px]">
            <button
              type="button"
              aria-expanded={keyOpen}
              className="inline-flex cursor-pointer items-center gap-[6px] border-0 bg-transparent p-0 font-sans text-[13px] font-medium leading-normal text-(--text-secondary) transition-colors hover:text-(--text-primary)"
              onClick={() => setKeyOpen((v) => !v)}
            >
              <Icon
                name="chevron-right"
                size={14}
                strokeWidth={2}
                className={keyOpen ? 'flex-none rotate-90 transition-transform' : 'flex-none transition-transform'}
              />
              Headless client? Use an API key
            </button>
            <a className="lnk ml-auto text-[13px]" href={moreUrl} target="_blank" rel="noopener noreferrer">
              MCP docs
              <Icon name="arrow-up-right" size={13} />
            </a>
          </div>
          {keyOpen ? (
            <p className="m-0 mt-[10px] ml-5 font-sans text-[12.5px] font-normal leading-[1.6] text-pretty text-(--text-tertiary)">
              Skip OAuth: send a key from Profile → API keys as&#32;
              <span className="mono text-[12px] text-(--text-secondary)">Authorization: Bearer &lt;key&gt;</span>. It
              carries your full permissions.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
