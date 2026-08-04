// No 'use client' here: rendered only inside ModalProvider's tree (the client boundary).

import { Icon } from '@/components/ui'

// Hover preview for the "Copy manifest & open Slack" button — a miniature of Slack's
// "Create new app" dialog cropped to the two "Or start your own way" tiles, with the
// "From a manifest" tile blinking so the user knows exactly which option to click once the
// manifest is on their clipboard. Styled like Slack's own (light) dialog; pointer-events-none
// so it never intercepts the button's click.
export function SlackManifestPreview() {
  return (
    <div className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 w-[320px] -translate-x-1/2 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
      <div className="rounded-xl border border-[#e0e0e2] bg-white p-3 shadow-(--shadow-xl)">
        <div className="mb-2 flex items-center gap-1.5 font-sans text-[11px] font-semibold leading-normal text-[#616061]">
          <Icon name="mouse-pointer-click" size={12} />
          In Slack, pick &ldquo;From a manifest&rdquo;
        </div>
        <div className="mb-1.5 font-sans text-[9.5px] font-semibold uppercase leading-normal tracking-wide text-[#8d8d8d]">
          Or start your own way
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="relative rounded-lg bg-white p-2.5">
            <span className="pointer-events-none absolute rounded-lg inset-0 slack-hint-blink rounded-[10px] ring-2 ring-[#1264a3]" />
            <span className="mb-1.5 flex h-6 w-6 items-center justify-center rounded-md bg-[#f4f4f4] text-[#454545]">
              <Icon name="scroll-text" size={14} />
            </span>
            <div className="font-sans text-[11.5px] font-bold leading-tight text-[#1d1c1d]">From a manifest</div>
            <div className="mt-0.5 font-sans text-[10px] leading-tight text-[#616061]">Upload JSON or YAML config.</div>
          </div>
          <div className="rounded-lg border border-[#e0e0e2] bg-white p-2.5">
            <span className="mb-1.5 flex h-6 w-6 items-center justify-center rounded-md bg-[#f4f4f4] text-[#454545]">
              <Icon name="clapperboard" size={14} />
            </span>
            <div className="font-sans text-[11.5px] font-bold leading-tight text-[#1d1c1d]">Blank app</div>
            <div className="mt-0.5 font-sans text-[10px] leading-tight text-[#616061]">
              Empty app with minimal setup.
            </div>
          </div>
        </div>
        <div className="mt-2 font-sans text-[10px] leading-snug text-[#616061]">
          Then paste the copied manifest, choose a workspace, and create the app.
        </div>
      </div>
      <div className="absolute -bottom-1 left-1/2 h-2.5 w-2.5 -translate-x-1/2 rotate-45 border-r border-b border-[#e0e0e2] bg-white" />
    </div>
  )
}

// Hover preview for "Open Slack app config tokens" — an animated mock of Slack's apps page
// scrolling down to the "Your App Configuration Tokens" section and pulsing the access
// token's Copy button (then the refresh token's), so the user sees exactly where the pair
// lives. Uses the design's .cfgtok-pop container (above the button, surface-card, downward
// caret). pointer-events-none.
export function SlackConfigTokenPreview() {
  return (
    <div className="cfgtok-pop rounded-xl border border-(--border-default) bg-(--surface-card) p-2 shadow-(--shadow-xl)">
      <div className="overflow-hidden rounded-lg border border-(--border-subtle) bg-(--surface-app)">
        <div className="flex items-center gap-1.5 border-b border-(--border-subtle) px-2.5 py-1.5">
          <span className="h-2 w-2 flex-none rounded-full bg-[#e0605a]" />
          <span className="h-2 w-2 flex-none rounded-full bg-[#e8b13a]" />
          <span className="h-2 w-2 flex-none rounded-full bg-[#4aa564]" />
          <span className="ml-1 min-w-0 truncate font-mono text-[9px] leading-normal text-(--text-tertiary)">
            api.slack.com/apps
          </span>
        </div>
        <div className="h-[140px] overflow-hidden bg-(--surface-card)">
          <div className="cfg-scroll px-2.5 py-2">
            <div className="mb-1.5 font-sans text-[10px] font-bold leading-tight text-(--text-primary)">Your apps</div>
            {[0, 1].map((i) => (
              <div
                key={i}
                className="mb-1.5 flex items-center gap-2 rounded-md border border-(--border-subtle) px-2 py-1.5"
              >
                <span className="h-4 w-4 flex-none rounded bg-(--surface-active)" />
                <span className="h-1.5 w-24 rounded-full bg-(--surface-active)" />
              </div>
            ))}
            <div className="mt-2 rounded-md border border-(--border-subtle) bg-(--surface-app) p-2">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="font-sans text-[10px] font-bold leading-tight text-(--text-primary)">
                  Your App Configuration Tokens
                </span>
                <span className="flex-none rounded bg-(--surface-active) px-1.5 py-[3px] font-sans text-[8px] font-semibold leading-normal text-(--text-secondary)">
                  Generate Token
                </span>
              </div>
              <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-2 gap-y-1">
                <span className="font-sans text-[8px] font-semibold uppercase leading-normal text-(--text-tertiary)">
                  Workspace
                </span>
                <span className="font-sans text-[8px] font-semibold uppercase leading-normal text-(--text-tertiary)">
                  Access
                </span>
                <span className="font-sans text-[8px] font-semibold uppercase leading-normal text-(--text-tertiary)">
                  Refresh
                </span>
                <span className="font-mono text-[9px] leading-normal text-(--text-secondary)">your-workspace</span>
                <span className="relative rounded border border-(--border-default) bg-(--surface-card) px-1.5 py-[3px] font-sans text-[8.5px] font-semibold leading-normal text-(--text-secondary)">
                  Copy
                  <span className="pointer-events-none absolute -inset-[3px] cfg-click-a rounded ring-2 ring-(--brand)" />
                </span>
                <span className="relative rounded border border-(--border-default) bg-(--surface-card) px-1.5 py-[3px] font-sans text-[8.5px] font-semibold leading-normal text-(--text-secondary)">
                  Copy
                  <span className="pointer-events-none absolute -inset-[3px] cfg-click-b rounded ring-2 ring-(--brand)" />
                </span>
              </div>
              <div className="mt-1 font-sans text-[8px] leading-normal text-(--text-tertiary)">Expires in 5 hours</div>
            </div>
          </div>
        </div>
      </div>
      <div className="mt-1.5 px-1 font-sans text-[10.5px] font-normal leading-[1.45] text-(--text-secondary)">
        Scroll to the bottom of <span className="mono">Your apps</span> — the token pair lives under &ldquo;App
        configuration tokens&rdquo;.
      </div>
    </div>
  )
}
