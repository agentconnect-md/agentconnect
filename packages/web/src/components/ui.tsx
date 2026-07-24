'use client'

import { icons, type LucideProps } from 'lucide-react'
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'

function toPascal(name: string): string {
  return name
    .split('-')
    .map((s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s))
    .join('')
}

export function Icon({
  name,
  size = 16,
  color,
  className,
  style,
  strokeWidth = 1.75
}: {
  name: string
  size?: number
  color?: string
  className?: string
  style?: CSSProperties
  strokeWidth?: number
}) {
  const Cmp = (icons as Record<string, React.ComponentType<LucideProps>>)[toPascal(name)]
  if (!Cmp) return null
  return <Cmp size={size} color={color} strokeWidth={strokeWidth} className={className} style={style} />
}

/**
 * Circular user/member avatar. Renders the `src` profile photo (a custom upload
 * or the OIDC fallback) when present, and otherwise — or if the image 404s / is
 * blocked — the colored initials badge every call site used before. `bg`/`fg`
 * style only the initials fallback; `fontSize` defaults to ~40% of `size`.
 */
export function Avatar({
  src,
  initials,
  size,
  bg = 'var(--magenta-100)',
  fg = 'var(--magenta-700)',
  fontSize,
  style
}: {
  src?: string | null
  initials: string
  size: number
  bg?: string
  fg?: string
  fontSize?: number
  style?: CSSProperties
}) {
  const [broken, setBroken] = useState(false)
  // A user can replace a failed provider photo with an uploaded profile photo
  // without this component remounting (e.g. the persistent shell avatar).
  useEffect(() => setBroken(false), [src])
  const base: CSSProperties = {
    width: size,
    height: size,
    borderRadius: '50%',
    flex: 'none',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    ...style
  }
  if (src && !broken) {
    return (
      <img
        src={src}
        alt=""
        // Avatar CDNs (Google's lh3.*, GitHub) can 403 a request that leaks a
        // referrer — send none. On any load error, fall back to the initials.
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
        className="object-cover"
        style={base}
      />
    )
  }
  return (
    <span
      className="font-sans font-semibold leading-normal"
      style={{
        ...base,
        background: bg,
        color: fg,
        fontSize: fontSize ?? Math.round(size * 0.4)
      }}
    >
      {initials}
    </span>
  )
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type ButtonSize = 'lg' | 'md' | 'sm' | 'xs'

export function Button({
  variant = 'primary',
  size = 'md',
  children,
  onClick,
  type = 'button',
  disabled = false,
  style,
  className
}: {
  variant?: ButtonVariant
  size?: ButtonSize
  children: ReactNode
  onClick?: () => void
  type?: 'button' | 'submit'
  disabled?: boolean
  style?: CSSProperties
  className?: string
}) {
  const sizeCls = size === 'lg' ? ' lg' : size === 'sm' ? ' sm' : size === 'xs' ? ' xs' : ''
  return (
    <button
      type={type}
      disabled={disabled}
      className={`dsbtn${sizeCls} dsbtn-${variant}${className ? ` ${className}` : ''}`}
      onClick={onClick}
      style={style}
    >
      {children}
    </button>
  )
}

export function Toggle({
  checked,
  disabled,
  onChange,
  ariaLabel
}: {
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
  ariaLabel?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      className={checked ? 'dstoggle on' : 'dstoggle'}
      onClick={() => onChange(!checked)}
    >
      <span className="dstoggle-knob" />
    </button>
  )
}

export function Input({
  label,
  placeholder,
  mono = false,
  type = 'text',
  size = 'md',
  defaultValue,
  hint
}: {
  label?: string
  placeholder?: string
  mono?: boolean
  type?: string
  size?: 'md' | 'lg'
  defaultValue?: string
  hint?: string
}) {
  return (
    <label className="dsinput">
      {label && <span className="fldlbl">{label}</span>}
      <input
        className={`dsinput-field${mono ? ' mono' : ''}${size === 'lg' ? ' lg' : ''}`}
        placeholder={placeholder}
        type={type}
        defaultValue={defaultValue}
      />
      {hint && <span className="dsinput-hint">{hint}</span>}
    </label>
  )
}
