'use client'

// The closed-beta waitlist experience,
// built to the shared "Waitlist" + "On List" designs. A two-column card:
//   left  = intake form → "verify your email" SSO step → status
//   right = editorial panel (light while requesting, dark once on the list)
//
// State machine, driven by GET /me/access + the Logto session:
//   loading → intake  (not signed in, or signed in with status 'none')
//   intake  → auth    (not signed in: reveal GitHub/Google to verify the email)
//   auth    → (Logto round-trip) → auto-submit stashed intake → onlist
//   intake  → (signed in) submit directly → onlist
//   pending/approved → onlist ;  active → bounce to the console
//
// Lives OUTSIDE the (app) route group, so it renders bare (no console shell). The
// email is always the verified OIDC identity — never free-typed (§8).

import { useEffect, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { FaSlack, FaTelegram, FaDiscord } from 'react-icons/fa'
import { Icon } from '@/components/ui'
import { Spinner, Wordmark } from '@/components/marks'
import SocialLoginButtons from '@/components/SocialLoginButtons'
import { getMyAccess, joinWaitlist, type WaitlistIntake } from '@/lib/api'
import { getUser, isAuthConfigured, login, logout } from '@/lib/auth'
import { socialLoginProviders, type SocialLoginTarget } from '@/lib/social-login-providers'

type Phase = 'loading' | 'intake' | 'auth' | 'onlist' | 'error'
type Platform = 'slack' | 'telegram' | 'discord'
type Provider = SocialLoginTarget

const DOCS_URL = 'https://docs.agentconnect.md'
// Verified sender of the activation email. Deploy-time config, so it comes from the
// runtime env (window.__AC_ENV, see lib/public-env) rather than being baked in —
// a fork or tenant mailing from its own domain sets WAITLIST_FROM_EMAIL.
const FROM_EMAIL_DEFAULT = 'no-reply@agentconnect.md'
const INTAKE_KEY = 'ac.wl.intake'
const PROVIDER_KEY = 'ac.wl.provider'
const TEAM_SIZES = ['Just me', '2–10', '11–50', '51–200', '200+']
const PROVIDER_LABELS: Record<string, string> = Object.fromEntries(
  socialLoginProviders().map((p) => [p.target, `via ${p.name}`])
)
const PLATFORMS: { id: Platform; label: string; Mark: typeof FaSlack }[] = [
  { id: 'slack', label: 'Slack', Mark: FaSlack },
  { id: 'telegram', label: 'Telegram', Mark: FaTelegram },
  { id: 'discord', label: 'Discord', Mark: FaDiscord }
]

const readStash = <T,>(key: string): T | null => {
  try {
    const raw = sessionStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}
const writeStash = (key: string, value: unknown) => {
  try {
    sessionStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* sessionStorage unavailable — the SSO round-trip just loses the draft */
  }
}
const clearStash = (key: string) => {
  try {
    sessionStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}

/** Whether a stashed draft has every required field (so it can be auto-submitted
 *  after the SSO round-trip). Guards against a partial or legacy-shaped draft. */
const isCompleteIntake = (d: Partial<WaitlistIntake> | null): d is WaitlistIntake =>
  !!(
    d &&
    d.name?.trim() &&
    d.company?.trim() &&
    Array.isArray(d.platform) &&
    d.platform.length > 0 &&
    d.teamSize?.trim()
  )

export default function Waitlist() {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>('loading')
  const [status, setStatus] = useState<'pending' | 'approved'>('pending')
  const [email, setEmail] = useState<string | null>(null)
  const [provider, setProvider] = useState<Provider | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Intake form fields. Everything is required EXCEPT the use-case (the only field
  // the design tags "(optional)"). Platform is a multi-select — pick one or more.
  const [name, setName] = useState('')
  const [company, setCompany] = useState('')
  const [platforms, setPlatforms] = useState<Platform[]>([])
  const [teamSize, setTeamSize] = useState('')
  const [useCase, setUseCase] = useState('')

  const togglePlatform = (id: Platform) =>
    setPlatforms((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]))

  // The required fields must be present before "Request access" is enabled.
  const canSubmit = !!(name.trim() && company.trim() && platforms.length > 0 && teamSize)

  // Called only when canSubmit is true, so the required fields are non-empty.
  const collectIntake = (): WaitlistIntake => ({
    name: name.trim(),
    company: company.trim(),
    platform: platforms,
    teamSize,
    ...(useCase.trim() ? { useCase: useCase.trim() } : {})
  })

  // Populate the form from a (possibly partial / legacy) stashed draft. A pre-multi-
  // select draft has a scalar `platform` ("slack") — coerce to an array so the chip
  // toggle never runs .filter on a string.
  const restoreDraft = (d: Partial<WaitlistIntake>) => {
    setName(d.name ?? '')
    setCompany(d.company ?? '')
    const p: unknown = d.platform
    setPlatforms(Array.isArray(p) ? (p as Platform[]) : typeof p === 'string' ? [p as Platform] : [])
    setTeamSize(d.teamSize ?? '')
    setUseCase(d.useCase ?? '')
  }

  const showOnList = (s: 'pending' | 'approved', mail: string | null) => {
    setStatus(s)
    setEmail(mail)
    setProvider(readStash<Provider>(PROVIDER_KEY))
    setPhase('onlist')
  }

  const submit = async (intake: WaitlistIntake, mail: string | null) => {
    setSubmitting(true)
    setError(null)
    try {
      const { status: s } = await joinWaitlist(intake)
      clearStash(INTAKE_KEY)
      showOnList(s === 'approved' ? 'approved' : 'pending', mail)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not submit your request.')
      setPhase('intake')
    } finally {
      setSubmitting(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      // No auth configured (OSS no-auth) ⇒ waitlist can't apply; go to the console.
      if (!isAuthConfigured()) {
        router.replace('/')
        return
      }
      const signedIn = !!(await getUser())
      if (cancelled) return
      if (!signedIn) {
        // Restore any in-progress draft so the form isn't lost across an SSO trip.
        const draft = readStash<Partial<WaitlistIntake>>(INTAKE_KEY)
        if (draft) restoreDraft(draft)
        setPhase('intake')
        return
      }
      try {
        const access = await getMyAccess()
        if (cancelled) return
        if (!access.waitlistMode || access.status === 'active') {
          router.replace('/')
          return
        }
        if (access.status === 'pending' || access.status === 'approved') {
          showOnList(access.status, access.email)
          return
        }
        // status 'none': just back from SSO with a complete stashed draft ⇒ submit it.
        // An incomplete/legacy draft is restored into the form instead (server would
        // 400 an incomplete body anyway).
        const draft = readStash<Partial<WaitlistIntake>>(INTAKE_KEY)
        if (isCompleteIntake(draft)) {
          await submit(draft, access.email)
          return
        }
        if (draft) restoreDraft(draft)
        setEmail(access.email)
        setPhase('intake')
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Something went wrong.')
          setPhase('error')
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [router])

  // "Request access": signed in ⇒ submit now; otherwise reveal the SSO verify step.
  const requestAccess = async () => {
    if (email) {
      await submit(collectIntake(), email)
    } else {
      setPhase('auth')
    }
  }

  const continueWith = (p: Provider) => {
    writeStash(INTAKE_KEY, collectIntake())
    writeStash(PROVIDER_KEY, p)
    try {
      sessionStorage.setItem('ac.returnTo', '/waitlist')
    } catch {
      /* ignore */
    }
    void login(p)
  }

  const signOut = () => {
    clearStash(INTAKE_KEY)
    clearStash(PROVIDER_KEY)
    if (isAuthConfigured()) void logout()
    else router.replace('/login')
  }

  return (
    <div className="wl-scope">
      <div className="wl-card">
        {phase === 'onlist' ? (
          <OnListColumn
            status={status}
            email={email}
            provider={provider}
            onSignOut={signOut}
            onRefresh={() => window.location.reload()}
          />
        ) : (
          <div className="wl-formcol">
            {phase === 'loading' && (
              <div className="m-auto">
                <Spinner size={42} />
              </div>
            )}

            {phase === 'error' && (
              <div className="m-auto flex flex-col items-center gap-4 text-center">
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-(--status-error-soft)">
                  <Icon name="triangle-alert" size={22} color="var(--status-error)" />
                </span>
                <div>
                  <h1 className="wl-h1" style={{ fontSize: 22 }}>
                    Something went wrong
                  </h1>
                  <p className="mt-2 text-[13px] leading-[1.55] text-(--text-secondary)">{error}</p>
                </div>
              </div>
            )}

            {phase === 'intake' && (
              <div className="wl-in">
                <div className="wl-eyebrow">Join the waitlist</div>
                <h1 className="wl-h1">Request your invite</h1>
                <p className="mt-[10px] text-[14px] leading-[1.55] text-(--text-secondary)">
                  AgentConnect is in a closed beta. Tell us a little about your team and we&apos;ll send an activation
                  link when a seat opens.
                </p>

                <div className="mt-7 flex flex-col gap-4">
                  <div className="flex gap-[14px]">
                    <div className="flex-1">
                      <label className="wl-lbl">Name</label>
                      <input
                        className="wl-input"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Jordan Rivera"
                      />
                    </div>
                    <div className="flex-1">
                      <label className="wl-lbl">Company / team</label>
                      <input
                        className="wl-input"
                        value={company}
                        onChange={(e) => setCompany(e.target.value)}
                        placeholder="Northwind Ops"
                      />
                    </div>
                  </div>

                  <div className="flex gap-[14px]">
                    <div className="flex-1">
                      <label className="wl-lbl">Which platforms will your team use?</label>
                      <div className="flex gap-2">
                        {PLATFORMS.map(({ id, label, Mark }) => {
                          const on = platforms.includes(id)
                          return (
                            <button
                              key={id}
                              type="button"
                              className={on ? 'plat on' : 'plat'}
                              aria-pressed={on}
                              onClick={() => togglePlatform(id)}
                            >
                              <Mark size={16} aria-hidden />
                              {label}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-[14px]">
                    <div className="flex-1">
                      <label className="wl-lbl">Team size</label>
                      <select className="wl-select" value={teamSize} onChange={(e) => setTeamSize(e.target.value)}>
                        <option value="" disabled>
                          Select
                        </option>
                        {TEAM_SIZES.map((t) => (
                          <option key={t}>{t}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex-1" />
                  </div>

                  <div>
                    <label className="wl-lbl">
                      What do you want agents to handle? <span className="wl-req">(optional)</span>
                    </label>
                    <textarea
                      className="wl-area"
                      value={useCase}
                      onChange={(e) => setUseCase(e.target.value)}
                      placeholder="e.g. triage #support, run deploys from a command, summarize standups…"
                    />
                  </div>
                </div>

                {error && <p className="mt-3 text-[12px] leading-[1.5] text-(--status-error)">{error}</p>}

                <button
                  type="button"
                  className="wl-btn-primary mt-6"
                  onClick={requestAccess}
                  disabled={submitting || !canSubmit}
                >
                  {submitting ? 'Submitting…' : 'Request access'}
                  {!submitting && <Icon name="arrow-right" size={17} />}
                </button>
              </div>
            )}

            {phase === 'auth' && (
              <div className="wl-in flex flex-col">
                <button type="button" className="backlink" onClick={() => setPhase('intake')}>
                  <Icon name="arrow-left" size={15} />
                  Back to details
                </button>
                <div
                  className="mt-[22px] flex h-[52px] w-[52px] items-center justify-center rounded-[12px] text-(--brand)"
                  style={{ background: 'var(--brand-soft)' }}
                >
                  <Icon name="shield-check" size={26} color="var(--brand)" />
                </div>
                <h1 className="wl-h1 mt-5" style={{ fontSize: 26 }}>
                  Verify it&apos;s your email
                </h1>
                <p className="mt-[10px] max-w-[380px] text-[14px] leading-[1.55] text-(--text-secondary)">
                  Sign in with the account you want your invite tied to. We only use it to confirm your email — no free
                  typing, no spoofing.
                </p>
                <div className="mt-[26px] flex max-w-[380px] flex-col gap-3">
                  <SocialLoginButtons
                    providers={socialLoginProviders()}
                    onContinue={continueWith}
                    darkTarget="github"
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Editorial panel: light while requesting, hidden once we render the dark
            On-List column (which brings its own dark aside). */}
        {phase !== 'onlist' && <IntakeAside />}
      </div>
    </div>
  )
}

/* ── The "On List" left column + its dark editorial aside ─────────────────── */
function OnListColumn({
  status,
  email,
  provider,
  onSignOut,
  onRefresh
}: {
  status: 'pending' | 'approved'
  email: string | null
  provider: Provider | null
  onSignOut: () => void
  onRefresh: () => void
}) {
  // A stashed provider is unvalidated JSON, so an unknown value degrades to no
  // label rather than rendering "Verified undefined".
  const providerLabel = (provider && PROVIDER_LABELS[provider]) || ''
  const lead =
    status === 'approved'
      ? 'You’re approved. Your activation link is on its way — open it to finish setting up your account.'
      : 'Thanks for requesting access. We review requests weekly and send activation links in small batches — no need to check back.'
  return (
    <>
      <div className="wl-formcol wl-in">
        <Wordmark height={26} />
        <div className="my-auto py-[34px]">
          <div className="relative h-16 w-16">
            <span
              className="absolute inset-0 rounded-full bg-(--brand)"
              style={{ opacity: 0.18, animation: 'wlRing 1.6s var(--ease-out, cubic-bezier(.16,1,.3,1)) .2s' }}
            />
            <div
              className="relative flex h-16 w-16 items-center justify-center rounded-full text-(--brand)"
              style={{
                background: 'var(--brand-soft)',
                animation: 'wlPop .42s var(--ease-out, cubic-bezier(.16,1,.3,1))'
              }}
            >
              <Icon name="check" size={30} color="var(--brand)" />
            </div>
          </div>
          <h1 className="wl-h1 mt-[26px]" style={{ fontSize: 30 }}>
            You&apos;re on the list
          </h1>
          <p className="mt-[10px] max-w-[420px] text-[15px] leading-[1.6] text-(--text-secondary)">{lead}</p>

          {email && (
            <div
              className="mt-5 inline-flex h-[34px] items-center gap-[9px] rounded-full border border-(--border-subtle) pl-[11px] pr-3"
              style={{ background: 'var(--surface-sunken)' }}
            >
              <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-(--status-online) text-white">
                <Icon name="check" size={12} color="#fff" />
              </span>
              <span className="text-[12.5px] font-medium text-(--text-secondary)">Verified {providerLabel}</span>
              <span className="h-[14px] w-px bg-(--border-default)" />
              <span className="wl-mono text-[12.5px] text-(--text-primary)">{email}</span>
            </div>
          )}

          <div className="mt-[30px]">
            <div className="wl-eyebrow" style={{ color: 'var(--text-tertiary)', marginBottom: 16 }}>
              What happens next
            </div>
            <Timeline status={status} email={email} />
          </div>

          <div className="mt-[30px] flex gap-3">
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="wl-btn-primary"
              style={{ width: 'auto', padding: '0 20px' }}
            >
              <Icon name="book-open" size={16} color="#fff" />
              Read the docs
            </a>
            <button type="button" className="wl-btn-ghost" onClick={onRefresh}>
              Check status
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-(--border-subtle) pt-5">
          <span className="text-[12px] text-(--text-tertiary)">
            Not {email ? <span className="wl-mono text-(--text-secondary)">{email}</span> : 'you'}?
          </span>
          <button type="button" className="flink" onClick={onSignOut}>
            Sign out &amp; use another account
          </button>
        </div>
      </div>
      <OnListAside />
    </>
  )
}

// Resolve at render (not module load) so it reads the runtime config: window.__AC_ENV
// in the browser, plain env during SSR. The SSR branch honours the NEXT_PUBLIC_ form
// too, because public-env's resolve() folds it into __AC_ENV — reading only the plain
// name here would render the default on the server and the override on the client.
function fromEmail(): string {
  if (typeof window !== 'undefined') return window.__AC_ENV?.WAITLIST_FROM_EMAIL || FROM_EMAIL_DEFAULT
  return process.env.WAITLIST_FROM_EMAIL || process.env.NEXT_PUBLIC_WAITLIST_FROM_EMAIL || FROM_EMAIL_DEFAULT
}

function Timeline({ status, email }: { status: 'pending' | 'approved'; email: string | null }) {
  const mail = email ? <span className="wl-mono text-(--text-primary)">{email}</span> : 'your inbox'
  const steps: { title: string; body: ReactNode; done: boolean; active: boolean }[] = [
    {
      title: 'Request reviewed',
      body: <>We look over new requests every week. Most teams hear back within a week or two.</>,
      done: status === 'approved',
      active: status === 'pending'
    },
    {
      title: 'Activation link emailed',
      body: (
        <>
          Your link arrives at {mail} from <span className="wl-mono text-(--text-primary)">{fromEmail()}</span>.
        </>
      ),
      done: false,
      active: status === 'approved'
    },
    {
      title: 'Deploy your first agent',
      body: <>Open the link, connect a workspace, and go live in minutes.</>,
      done: false,
      active: false
    }
  ]
  return (
    <div className="flex flex-col">
      {steps.map((s, i) => {
        const filled = s.done || s.active
        return (
          <div key={s.title} className="flex gap-[14px]">
            <div className="flex flex-col items-center">
              <span
                className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-full font-mono text-[12px] font-semibold"
                style={
                  filled
                    ? { background: 'var(--brand)', color: '#fff' }
                    : {
                        background: 'var(--surface-card)',
                        border: '1.5px solid var(--border-default)',
                        color: 'var(--text-tertiary)'
                      }
                }
              >
                {s.done ? <Icon name="check" size={13} color="#fff" /> : i + 1}
              </span>
              {i < steps.length - 1 && <span className="my-1 w-[2px] flex-1 bg-(--border-subtle)" />}
            </div>
            <div className={i < steps.length - 1 ? 'pb-[18px]' : ''}>
              <div className="text-[14px] font-semibold text-(--text-primary)">{s.title}</div>
              <div className="mt-[2px] text-[13px] leading-[1.5] text-(--text-secondary)">{s.body}</div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

/* ── Editorial asides ─────────────────────────────────────────────────────── */
const FEATURES: { icon: string; title: string; body: string }[] = [
  {
    icon: 'message-square',
    title: 'Agents in your channels',
    body: 'Slack, Telegram and Discord — no new app to learn.'
  },
  {
    icon: 'activity',
    title: 'One operator console',
    body: 'Volume, latency, escalations and live transcripts in one view.'
  },
  { icon: 'key', title: 'Your keys stay put', body: 'Agents run on your machines — credentials never leave them.' }
]

function IntakeAside() {
  return (
    <aside className="wl-aside">
      <div
        className="inline-flex h-[26px] items-center gap-[7px] self-start rounded-full border border-(--border-subtle) px-[11px] font-mono text-[11.5px] font-semibold uppercase tracking-[.05em] text-(--text-secondary)"
        style={{ background: 'var(--surface-card)' }}
      >
        <span
          className="h-[6px] w-[6px] rounded-full bg-(--status-online)"
          style={{ boxShadow: '0 0 0 3px rgba(21,166,97,.22)' }}
        />
        Invite-only preview
      </div>
      <div className="mt-[26px] max-w-[340px] text-[24px] font-semibold leading-[1.3] tracking-[-.02em]">
        Agents that live where your team already talks.
      </div>
      <div className="mt-[26px] flex flex-col gap-3">
        {FEATURES.map((f) => (
          <div key={f.title} className="flex items-start gap-3">
            <span
              className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-[6px] text-(--brand)"
              style={{ background: 'var(--brand-soft)' }}
            >
              <Icon name={f.icon} size={15} color="var(--brand)" />
            </span>
            <div className="text-[13.5px] leading-[1.5] text-(--text-secondary)">
              <span className="font-semibold text-(--text-primary)">{f.title}.</span> {f.body}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-auto pt-[26px]">
        <div className="mb-3 font-mono text-[11px] font-semibold uppercase tracking-[.08em] text-(--text-tertiary)">
          Runs on
        </div>
        <div className="flex gap-[9px]">
          {PLATFORMS.map(({ id, label, Mark }) => (
            <span
              key={id}
              className="flex h-[38px] w-[38px] items-center justify-center rounded-[9px] border border-(--border-subtle) text-(--text-secondary)"
              style={{ background: 'var(--surface-card)' }}
              title={label}
            >
              <Mark size={18} aria-hidden />
            </span>
          ))}
        </div>
      </div>
    </aside>
  )
}

function OnListAside() {
  return (
    <aside className="wl-aside dark">
      <div className="inline-flex h-[26px] items-center gap-[7px] self-start rounded-full border border-[rgba(255,255,255,.12)] bg-[rgba(255,255,255,.07)] px-[11px] font-mono text-[11.5px] font-semibold uppercase tracking-[.05em] text-(--text-inverse-dim)">
        While you wait
      </div>
      <div className="mt-[26px] max-w-[340px] text-[25px] font-semibold leading-[1.28] tracking-[-.02em]">
        Here&apos;s what you&apos;ll be running.
      </div>
      <div className="mt-[26px] flex flex-col gap-[14px]">
        {FEATURES.map((f) => (
          <div key={f.title} className="flex items-start gap-[13px]">
            <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[8px] border border-[rgba(255,255,255,.10)] bg-[rgba(255,255,255,.06)] text-white">
              <Icon name={f.icon} size={16} color="#fff" />
            </span>
            <div>
              <div className="text-[14px] font-semibold text-white">{f.title}</div>
              <div className="mt-[2px] text-[13px] leading-[1.5] text-(--text-inverse-dim)">{f.body}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-auto">
        <div className="mb-3 font-mono text-[11px] font-semibold uppercase tracking-[.08em] text-[rgba(255,255,255,.4)]">
          Deploy to
        </div>
        <div className="flex gap-[9px]">
          {PLATFORMS.map(({ id, label, Mark }) => (
            <span
              key={id}
              className="flex h-[40px] w-[40px] items-center justify-center rounded-[10px] border border-[rgba(255,255,255,.10)] bg-[rgba(255,255,255,.06)] text-white"
              title={label}
            >
              <Mark size={18} aria-hidden />
            </span>
          ))}
        </div>
      </div>
    </aside>
  )
}
