'use client'

// Agent-type + IM-platform brand marks.
// Sized to 60% of their container to match the .av / .imark CSS.

import { useState } from 'react'
import { Icon } from './ui'
import { withIconUrl, type AgentIcon } from '@/lib/agent-icon'
import gitlabIcon from '@iconify-icons/logos/gitlab'
import kubernetesIcon from '@iconify-icons/logos/kubernetes'
import slackIcon from '@iconify-icons/logos/slack-icon'
import webhooksLogoFillIcon from '@iconify-icons/ph/webhooks-logo-fill'
import { Icon as IconifyIcon } from '@iconify/react'
import { FcGoogle } from 'react-icons/fc'
import { SiGithub } from 'react-icons/si'
import { acpRuntime, useAcpRegistry } from '@/lib/acp-registry'
import { LARK_MARK_SRC } from './console/platforms/feishu/mark'
import { platformMark } from './console/platforms/marks'
import { markBox, squareMarkBox } from './mark-box'
import type { SocialLoginTarget } from '@/lib/social-login-providers'

const fill = { width: '60%', height: '60%', display: 'block' } as const

// Dark-mode treatment for the brand logos we can only load as an <img> (ACP registry
// / lobehub SVGs, so no per-path recoloring): most are `currentColor`-black and have
// to be flipped to read on the dark surface, but a plain `invert` also rotates the
// hue of the colored ones (Kiro's purple ghost came out green). The extra 180°
// rotation puts those hues back; on a pure black glyph it is a no-op.
const DARK_MARK_FILTER = "[html[data-theme='dark']_&]:invert [html[data-theme='dark']_&]:hue-rotate-180"

export function AgentMark({ model, fillPct = 60 }: { model: string; fillPct?: number }) {
  const registry = useAcpRegistry()
  const registryIcon = acpRuntime(registry, model)?.icon
  if (!registryIcon) return null
  return (
    <img
      src={registryIcon}
      alt=""
      style={{ width: `${fillPct}%`, height: `${fillPct}%` }}
      className={`block object-contain ${DARK_MARK_FILTER}`}
    />
  )
}

// Map a model id to an AI-provider brand slug in the lobehub icon set. Handles the
// `provider/model` form (opencode / openrouter, e.g. `deepseek/deepseek-v4-flash`)
// first, then falls back to inferring the family from a bare model id. Returns null
// when it can't tell (⇒ caller shows the runtime mark instead).
// ponytail: substring/prefix heuristic; a wrong guess degrades gracefully because
// <ModelMark> falls back on the icon's onError. Add a mapping when a provider recurs.
const MODEL_PROVIDER_PREFIX: Record<string, string> = {
  deepseek: 'deepseek',
  openai: 'openai',
  anthropic: 'claude',
  google: 'gemini',
  'google-vertex': 'gemini',
  meta: 'meta',
  'meta-llama': 'meta',
  mistral: 'mistral',
  mistralai: 'mistral',
  qwen: 'qwen',
  alibaba: 'qwen',
  moonshot: 'moonshot',
  moonshotai: 'moonshot',
  xai: 'grok',
  'x-ai': 'grok',
  cohere: 'cohere',
  groq: 'groq',
  perplexity: 'perplexity',
  ollama: 'ollama',
  openrouter: 'openrouter'
}
export function modelProviderSlug(model: string): string | null {
  const m = model.toLowerCase().trim()
  if (!m) return null
  const prefix = m.includes('/') ? m.slice(0, m.indexOf('/')) : ''
  if (prefix && MODEL_PROVIDER_PREFIX[prefix]) return MODEL_PROVIDER_PREFIX[prefix]
  if (/deepseek/.test(m)) return 'deepseek'
  if (/claude|sonnet|opus|haiku/.test(m)) return 'claude'
  if (/gpt|codex|(?:^|[^a-z])o[134]\b/.test(m)) return 'openai'
  if (/gemini/.test(m)) return 'gemini'
  if (/mistral|mixtral|codestral/.test(m)) return 'mistral'
  if (/qwen/.test(m)) return 'qwen'
  if (/llama/.test(m)) return 'meta'
  if (/grok/.test(m)) return 'grok'
  if (/kimi|moonshot/.test(m)) return 'moonshot'
  // Unknown `provider/model`: try the raw prefix as a lobehub slug; onError falls back.
  return prefix || null
}

// A model's provider brand mark (lobehub icon set — same CDN the ACP registry's
// curated runtimes use). Distinct from <AgentMark>, which is the runtime brand:
// an `opencode` agent running `deepseek/…` shows the deepseek mark here, opencode there.
export function ModelMark({
  model,
  fallbackRuntime,
  fillPct = 80
}: {
  model: string
  fallbackRuntime: string
  fillPct?: number
}) {
  const slug = modelProviderSlug(model)
  // Latch the slug whose icon 404s so we fall back to the runtime mark. Keyed by
  // slug (not a boolean) so switching model re-attempts the new provider's icon —
  // no reset effect needed; `key` gives the img a fresh load per slug.
  const [failedSlug, setFailedSlug] = useState<string | null>(null)
  if (!slug || failedSlug === slug) return <AgentMark model={fallbackRuntime} fillPct={fillPct} />
  return (
    <img
      key={slug}
      src={`https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/${slug}.svg`}
      alt=""
      onError={() => setFailedSlug(slug)}
      style={{ width: `${fillPct}%`, height: `${fillPct}%` }}
      className={`block object-contain ${DARK_MARK_FILTER}`}
    />
  )
}

/**
 * Agent avatar — renders the stored {@link AgentIcon} descriptor, filling its
 * parent tile (which owns the box size + border-radius):
 *  - `glyph` → a white Lucide glyph on a solid color plate. Exception: the
 *    `agentconnect` brand diamond renders plateless (the native logo; its
 *    stored `color` is inert).
 *  - `image` → the image, cover-cropped.
 *  - `runtime` / null (legacy default) → the runtime brand mark (<AgentMark>) on
 *    the tile's own background, i.e. today's behavior.
 * `size` is the tile's pixel size (used to scale the glyph). Distinct from
 * <AgentMark>, which stays the pure runtime mark for the runtime-select fields.
 */
export function AgentIconView({
  icon,
  runtime,
  size,
  keepImagePlate
}: {
  icon?: AgentIcon | null
  runtime: string
  size: number
  /** Keep the white plate under an uploaded image on dark. Org tiles opt in: their
   * logos are usually dark-on-transparent, so plateless leaves an empty tile. */
  keepImagePlate?: boolean
}) {
  if (icon?.kind === 'glyph') {
    if (icon.glyph === 'agentconnect') {
      // The brand diamond (the built-in preset agents' fixed identity) — the
      // native logo, plateless: no background, `color` is inert. Mirrors the
      // CP's PNG renderer special case.
      return (
        <span data-agent-icon-glyph="true" className="flex h-full w-full items-center justify-center rounded-[inherit]">
          <LogoMark size={size} />
        </span>
      )
    }
    return (
      <span
        data-agent-icon-glyph="true"
        className="flex h-full w-full items-center justify-center rounded-[inherit]"
        style={{ background: icon.color }}
      >
        <Icon name={icon.glyph} color="#fff" size={Math.round(size * 0.56)} strokeWidth={2} />
      </span>
    )
  }
  if (icon?.kind === 'image' && icon.url) {
    // Inline width/height (not h-full/w-full utilities) so this beats the `.av img`
    // / `.imark img` 60% descendant rules and the avatar fills its tile. The url is
    // reassembled from the DTO `iconUrl` at the fetch boundary (agentFromDto/orgFromDto).
    return (
      <img
        src={icon.url}
        alt=""
        data-agent-icon-image="true"
        className={`rounded-[inherit] bg-white object-cover ${keepImagePlate ? '' : "[html[data-theme='dark']_&]:bg-transparent"}`}
        style={{ width: '100%', height: '100%' }}
      />
    )
  }
  return <AgentMark model={runtime} />
}

/** Organization avatar for selectors and other identity surfaces. Uploaded images
 * and stored glyphs use the shared icon renderer; legacy/invalid descriptors keep
 * the existing deterministic initial fallback instead of leaving an empty tile. */
export function OrgIconView({
  icon,
  iconUrl,
  label,
  fallbackColor,
  size,
  className
}: {
  icon?: AgentIcon | null
  iconUrl?: string | null
  label: string
  fallbackColor: string
  size: number
  className: string
}) {
  const resolved = withIconUrl(icon, iconUrl)
  const renderable = resolved?.kind === 'glyph' || (resolved?.kind === 'image' && Boolean(resolved.url))

  return (
    <span
      className={`flex flex-none items-center justify-center overflow-hidden font-sans font-semibold leading-normal text-white ${className}`}
      style={{ width: size, height: size, background: renderable ? undefined : fallbackColor }}
    >
      {renderable ? (
        <AgentIconView icon={resolved} runtime="" size={size} keepImagePlate />
      ) : (
        label.charAt(0).toUpperCase()
      )}
    </span>
  )
}

// GitHub octocat mark — rendered on the workspace tiles and cards instead of
// <Icon name="github" /> (which lucide no longer ships).
export function GithubMark({ color = 'currentColor', fillPct = 60 }: { color?: string; fillPct?: number }) {
  return (
    <SiGithub style={{ width: `${fillPct}%`, height: `${fillPct}%`, display: 'block' }} color={color} aria-hidden />
  )
}

// GitLab tanuki mark — {@link GithubMark}'s multi-color counterpart, hence no `color`; `ssr` draws it before mount.
export function GitlabMark({ fillPct = 60 }: { fillPct?: number }) {
  return <IconifyIcon icon={gitlabIcon} ssr style={markBox(fillPct)} aria-hidden />
}

/** The Kubernetes wheel — what a SELF-HOSTED pool is: the operator's own cluster, named by the
 *  thing they actually run. Cloud is the same pool as a product and keeps its own cloud glyph. */
export function KubernetesMark({ fillPct = 100 }: { fillPct?: number }) {
  return <IconifyIcon icon={kubernetesIcon} ssr style={markBox(fillPct)} aria-hidden />
}

/**
 * A mark for one integration surface. The CORE kinds (github / gitlab / webhook /
 * schedule / memory dream / playground+webchat) are the host's own; the chat platforms
 * come from their modules (§10 {@link WebPlatformModule.Mark}) through the light
 * `platforms/marks` lookup — see the note there on why this is not a read through
 * `platformRegistry`.
 *
 * Core kinds are still matched by SUBSTRING because their ids are synthesized in
 * several places (`sessionPlatform` folds `playground`→`webchat`, `hook`+github→
 * `github`; `sessionChannelDisplay` mints `schedule`). Chat platforms are matched
 * by EXACT id: those values come off the wire, where the vocabulary is closed.
 * Order is load-bearing — `hook` must be tested before `web`, or `webhook` would
 * take the playground arm.
 */
export function PlatformMark({ platform, fillPct = 60 }: { platform: string; fillPct?: number }) {
  const x = (platform || '').toLowerCase()
  // Marks render at 60% of their box to sit inside .av / .imark tiles; callers can override
  // fillPct — e.g. the Bots row fills a 14px box (fillPct=100) to match the design's full-bleed mark.
  const s = fillPct === 60 ? fill : markBox(fillPct)
  // GitHub ships as a full-bleed square glyph with no internal padding of its own,
  // so a caller asking for a full-bleed box (fillPct=100, e.g. the session rail
  // rows) would render it visibly larger than every other mark beside it. The
  // Slack and Discord marks take the same cap inside their own modules.
  const sq = squareMarkBox(fillPct)
  if (x.includes('github')) {
    return <SiGithub style={sq} color="currentColor" aria-hidden />
  }
  // The other code host, capped the same way: the tanuki is a full-bleed glyph too.
  if (x.includes('gitlab')) {
    return <IconifyIcon icon={gitlabIcon} ssr style={sq} aria-hidden />
  }
  if (x.includes('hook')) {
    return <IconifyIcon icon={webhooksLogoFillIcon} style={s} color="var(--brand)" aria-hidden />
  }
  // Headless schedule fires — no real platform channel behind them.
  if (x.includes('sched')) {
    return (
      <span style={{ width: s.width, height: s.height }} className="flex items-center justify-center" aria-hidden>
        <Icon name="calendar-clock" className="h-full w-full" />
      </span>
    )
  }
  if (x.includes('dream')) {
    return (
      <span style={{ width: s.width, height: s.height }} className="flex items-center justify-center" aria-hidden>
        {/* --brand, not --brand-soft-text: that token swings with the theme (a pale tint
            on dark, a deep wine on light), while one magenta reads on both surfaces —
            and matches the webhook mark above, the other brand-colored glyph here. */}
        <Icon name="moon" className="h-full w-full text-(--brand)" />
      </span>
    )
  }
  // 'playground' (live) and 'webchat' (its persisted session) share the sandbox mark.
  if (x.includes('play') || x.includes('web')) {
    return (
      <span
        style={{ width: s.width, height: s.height }}
        className="flex items-center justify-center rounded-[27%] bg-(--brand)"
        aria-hidden
      >
        <Icon name="flask-conical" size={16} color="#fff" className="h-[64%] w-[64%]" />
      </span>
    )
  }
  const Mark = platformMark(x)
  if (Mark) return <Mark fillPct={fillPct} />
  return (
    <span style={{ width: s.width, height: s.height }} className="flex items-center justify-center" aria-hidden>
      <Icon name="plug" className="h-full w-full" />
    </span>
  )
}

/**
 * Brand mark for a social sign-in method — shared by the login page and the
 * Profile "Sign-in methods" card so a provider added to the catalog
 * cannot render correctly in one place and wrong in the other.
 *
 * `size` defaults to the login button's 18px mark and can be overridden by
 * denser surfaces such as the Profile card.
 */
export function SocialLoginMark({ target, size }: { target: SocialLoginTarget; size?: number }) {
  if (target === 'github') return <SiGithub size={size} aria-hidden />
  if (target === 'slack')
    return <IconifyIcon icon={slackIcon} {...(size ? { width: size, height: size } : {})} aria-hidden />
  if (target === 'lark' || target === 'feishu')
    return (
      <img src={LARK_MARK_SRC} alt="" width={size ?? 18} height={size ?? 18} className="object-contain" aria-hidden />
    )
  return <FcGoogle size={size} aria-hidden />
}

// The diamond's four facets — geometry + brand fills shared by the static logo, the
// wordmark lockup, and the spinner, so the artwork exists in exactly one place.
const FACETS = [
  { points: '24,5 43,24 24,24', fill: '#f2c64a' },
  { points: '43,24 24,43 24,24', fill: '#f4793a' },
  { points: '24,43 5,24 24,24', fill: '#7c3ca2' },
  { points: '5,24 24,5 24,24', fill: '#d83f96' }
] as const

// The opacity a facet rests at in the spinner — reused as the depth of the hover fade below.
const FACET_DIM = 0.22

// Point at one facet of the static diamond and only that facet fades, to FACET_DIM
// (the literal is duplicated because Tailwind scans class strings, not values).
function DiamondFacets() {
  return (
    <>
      {FACETS.map((f) => (
        <polygon key={f.points} points={f.points} fill={f.fill} className="transition-opacity hover:opacity-[0.22]" />
      ))}
    </>
  )
}

export function Wordmark({ height = 36, inverse = false }: { height?: number; inverse?: boolean }) {
  const textFill = inverse ? '#ffffff' : '#3a2a4d'
  const accentFill = inverse ? '#ef7eb4' : '#c62a78'
  return (
    <svg
      height={height}
      viewBox="0 0 230 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="AgentConnect"
    >
      <DiamondFacets />
      <text
        x="58"
        y="31"
        fontFamily="Geist, -apple-system, sans-serif"
        fontSize="21"
        fontWeight="600"
        letterSpacing="-0.02em"
        fill={textFill}
      >
        Agent<tspan fill={accentFill}>Connect</tspan>
      </text>
    </svg>
  )
}

export function LogoMark({ size = 27 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="AgentConnect"
    >
      <DiamondFacets />
    </svg>
  )
}

// Loading spinner: the four logo facets chase in opacity around the diamond.
// `begin` is indexed by FACETS — one entry per facet, in that order, each an eighth of a cycle behind the last.
const SPIN = {
  dur: '1.4s',
  keyTimes: '0;0.18;0.7;1',
  values: `${FACET_DIM};1;${FACET_DIM};${FACET_DIM}`,
  begin: ['0s', '0.175s', '0.35s', '0.525s']
} as const

export function Spinner({ size = 48 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      role="img"
      aria-label="Loading"
      xmlns="http://www.w3.org/2000/svg"
    >
      {FACETS.map((f, i) => (
        <polygon key={f.points} points={f.points} fill={f.fill} opacity={FACET_DIM}>
          <animate
            attributeName="opacity"
            dur={SPIN.dur}
            repeatCount="indefinite"
            begin={SPIN.begin[i]}
            keyTimes={SPIN.keyTimes}
            values={SPIN.values}
          />
        </polygon>
      ))}
    </svg>
  )
}

// Centered spinner for a page/card body that is still waiting on its data pull.
// Shared so every view's loading state looks the same (cf. Usage / daemon detail).
//
// `fill` is for a WHOLE-VIEW loader (the sole thing on screen while a list/detail
// first loads): it reserves the content region and centres the spinner vertically,
// so a refresh doesn't strand it at the top of the tall mobile viewport. Leave it
// off for compact in-card section loaders (they keep the small top-padded box).
export function LoadingState({
  size = 30,
  padding = 48,
  fill = false
}: {
  size?: number
  padding?: number
  fill?: boolean
}) {
  if (fill)
    return (
      <div className="loadfill">
        <Spinner size={size} />
      </div>
    )
  return (
    <div className="flex justify-center" style={{ padding }}>
      <Spinner size={size} />
    </div>
  )
}
