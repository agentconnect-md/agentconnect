// No 'use client' here: rendered only inside OrganizationSsoCard (a client component).

import { useEffect, useId, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Button, Icon } from '@/components/ui'
import { Scrim } from '@/components/console/Scrim'
import {
  ApiError,
  prepareOrgSsoConnection,
  saveOrgSsoConnection,
  type OrgSsoConnectionDto,
  type OrgSsoConnectionInput,
  type OrgSsoOidcSettings,
  type OrgSsoProtocol,
  type OrgSsoSamlSettings,
  type OrgSsoServiceProvider
} from '@/lib/api'

const DEFAULT_SCOPE = 'openid email profile'
// Standard SAML and WS-Federation claim names, offered on the attribute fields.
const CLAIMS = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims'
const EMAIL_ATTRIBUTES = [
  'email',
  'mail',
  `${CLAIMS}/emailaddress`,
  `${CLAIMS}/upn`,
  `${CLAIMS}/name`,
  'urn:oid:0.9.2342.19200300.100.1.3'
]
const NAME_ATTRIBUTES = [
  'name',
  'displayName',
  `${CLAIMS}/name`,
  'http://schemas.microsoft.com/identity/claims/displayname',
  'urn:oid:2.16.840.1.113730.3.1.241'
]

const INPUT =
  'min-w-0 flex-1 border-0 bg-transparent font-[inherit] text-[length:inherit] outline-none placeholder:text-(--text-disabled)'

function Field({
  label,
  value,
  onChange,
  placeholder,
  mono = false,
  secret = false,
  autoFocus = false,
  suggestions
}: {
  label: string
  value: string
  onChange: (next: string) => void
  placeholder?: string
  mono?: boolean
  secret?: boolean
  autoFocus?: boolean
  suggestions?: readonly string[]
}) {
  const listId = useId()
  return (
    <label className="fld min-w-0">
      <span className="fldlbl">{label}</span>
      <div className={mono ? 'inp mn' : 'inp'}>
        <input
          className={INPUT}
          type={secret ? 'password' : 'text'}
          autoComplete={secret ? 'new-password' : 'off'}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoFocus={autoFocus}
          value={value}
          placeholder={placeholder}
          list={suggestions ? listId : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
        {suggestions && (
          <datalist id={listId}>
            {suggestions.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        )}
      </div>
    </label>
  )
}

/** A value to register at the identity provider: read-only, with a copy button. */
function CopyField({ label, value }: { label: string; value: string | null }) {
  const t = useTranslations('Settings.sso')
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable: the value stays selectable */
    }
  }
  return (
    <div className="fld min-w-0">
      <span className="fldlbl">{label}</span>
      <div className="inp mn bg-(--surface-sunken) pr-[5px] text-(--text-secondary)">
        <span className="min-w-0 flex-1 truncate select-all">{value ?? '…'}</span>
        <button
          type="button"
          className="iconbtn -my-[5px] h-7 w-7 border-transparent bg-transparent"
          title={t('copy')}
          aria-label={t('copy')}
          disabled={!value}
          onClick={() => void copy()}
        >
          <Icon name={copied ? 'check' : 'copy'} size={14} />
        </button>
      </div>
    </div>
  )
}

function Segments<V extends string>({
  label,
  value,
  options,
  disabled = false,
  onChange
}: {
  label: string
  value: V
  options: readonly { value: V; label: string }[]
  disabled?: boolean
  onChange: (next: V) => void
}) {
  return (
    <div className="pillbar self-start" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          disabled={disabled}
          className={
            value === option.value
              ? 'pill on whitespace-nowrap disabled:cursor-default'
              : 'pill whitespace-nowrap disabled:cursor-default disabled:opacity-50'
          }
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

const oidcSettings = (connection: OrgSsoConnectionDto | null): OrgSsoOidcSettings | null =>
  connection?.protocol === 'oidc' && connection.settings && 'issuer' in connection.settings ? connection.settings : null

const samlSettings = (connection: OrgSsoConnectionDto | null): OrgSsoSamlSettings | null =>
  connection?.protocol === 'saml' && connection.settings && 'attributeMapping' in connection.settings
    ? connection.settings
    : null

/** Create, edit or re-enter an organization's SSO connection; an existing connection keeps its protocol. */
export default function OrgSsoConnectionModal({
  orgId,
  connection,
  onClose,
  onSaved,
  onRemove
}: {
  orgId: string
  connection: OrgSsoConnectionDto | null
  onClose: () => void
  onSaved: () => void
  /** Hands an existing connection's removal to the caller, which confirms it. */
  onRemove: () => void
}) {
  const t = useTranslations('Settings.sso.connectionDialog')
  const tc = useTranslations('Common.actions')
  const titleId = useId()
  const savedOidc = oidcSettings(connection)
  const savedSaml = samlSettings(connection)
  const reconfigure = connection?.needsConfiguration === true

  const [protocol, setProtocol] = useState<OrgSsoProtocol>(connection?.protocol ?? 'oidc')
  const [name, setName] = useState(connection?.name ?? '')
  const [issuer, setIssuer] = useState(savedOidc?.issuer ?? '')
  const [clientId, setClientId] = useState(savedOidc?.clientId ?? '')
  const [clientSecret, setClientSecret] = useState('')
  const [replaceSecret, setReplaceSecret] = useState(false)
  const [scope, setScope] = useState(savedOidc?.scope || DEFAULT_SCOPE)
  const [source, setSource] = useState<'url' | 'xml'>(savedSaml?.metadata && !savedSaml.metadataUrl ? 'xml' : 'url')
  const [metadataUrl, setMetadataUrl] = useState(savedSaml?.metadataUrl ?? '')
  const [metadata, setMetadata] = useState(savedSaml?.metadata ?? '')
  const [emailAttribute, setEmailAttribute] = useState(savedSaml?.attributeMapping.email ?? 'email')
  const [nameAttribute, setNameAttribute] = useState(savedSaml?.attributeMapping.name ?? 'name')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // A healthy connection already carries its values; a new or re-entered one asks for the connector's.
  const known = connection && !reconfigure && connection.protocol === protocol ? connection.serviceProvider : null
  const [prepared, setPrepared] = useState<{ protocol: OrgSsoProtocol; values: OrgSsoServiceProvider } | null>(null)
  useEffect(() => {
    if (known) return
    let cancelled = false
    prepareOrgSsoConnection(protocol, orgId)
      .then((values) => {
        if (!cancelled) setPrepared({ protocol, values })
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [known, orgId, protocol])
  const serviceProvider = known ?? (prepared?.protocol === protocol ? prepared.values : null)

  // The saved secret stands only for the issuer it was saved with; a changed issuer needs it entered again.
  const keepsSecret =
    !reconfigure && savedOidc?.hasClientSecret === true && !replaceSecret && issuer.trim() === savedOidc.issuer

  const input = (): OrgSsoConnectionInput | null => {
    const displayName = name.trim()
    if (!displayName) return null
    if (protocol === 'oidc') {
      if (!issuer.trim() || !clientId.trim() || (!keepsSecret && !clientSecret)) return null
      return {
        protocol,
        name: displayName,
        issuer: issuer.trim(),
        clientId: clientId.trim(),
        ...(keepsSecret ? {} : { clientSecret }),
        ...(scope.trim() ? { scope: scope.trim() } : {})
      }
    }
    const document = source === 'url' ? metadataUrl.trim() : metadata.trim()
    if (!document) return null
    // The dialog has no field for the subject-ID attribute, so a saved one rides along unchanged.
    const mapping = {
      ...(savedSaml?.attributeMapping.id ? { id: savedSaml.attributeMapping.id } : {}),
      ...(emailAttribute.trim() ? { email: emailAttribute.trim() } : {}),
      ...(nameAttribute.trim() ? { name: nameAttribute.trim() } : {})
    }
    return {
      protocol,
      name: displayName,
      ...(source === 'url' ? { metadataUrl: document } : { metadata: document }),
      ...(Object.keys(mapping).length > 0 ? { attributeMapping: mapping } : {})
    }
  }
  const ready = input() !== null

  const save = async () => {
    const body = input()
    if (busy || !body) return
    setBusy(true)
    setError(null)
    try {
      await saveOrgSsoConnection(body, orgId)
      onSaved()
      onClose()
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SSO_CLIENT_SECRET_REQUIRED') {
        setReplaceSecret(true)
        setError(t('secretRequired'))
      } else {
        setError(e instanceof Error ? e.message : String(e))
      }
      setBusy(false)
    }
  }

  let secretField: ReactNode
  if (keepsSecret) {
    secretField = (
      <div className="fld min-w-0">
        <span className="fldlbl">{t('clientSecret')}</span>
        <div className="inp">
          <span className="flex-1" />
          <span className="badge flex-none bg-(--status-online-soft) text-(--status-online)">{t('secretSet')}</span>
          <Button
            variant="ghost"
            size="xs"
            className="-my-[5px] h-6 flex-none px-[6px]"
            onClick={() => setReplaceSecret(true)}
          >
            {t('replaceSecret')}
          </Button>
        </div>
      </div>
    )
  } else {
    secretField = (
      <Field
        label={t('clientSecret')}
        value={clientSecret}
        onChange={setClientSecret}
        placeholder={t('clientSecret')}
        secret
        autoFocus={replaceSecret}
      />
    )
  }

  return (
    <Scrim onEscape={busy ? undefined : onClose}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <div className="modalhead">
          <span id={titleId} className="flex-1 font-sans text-[16px] font-semibold leading-normal">
            {reconfigure ? t('reconfigureTitle') : connection ? t('editTitle') : t('createTitle')}
          </span>
          <button type="button" className="iconbtn" aria-label={tc('close')} disabled={busy} onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modalbody flex flex-col gap-[14px]">
          <Segments
            label={t('protocol')}
            value={protocol}
            disabled={connection !== null}
            options={[
              { value: 'oidc', label: 'OIDC' },
              { value: 'saml', label: 'SAML' }
            ]}
            onChange={(next) => {
              setProtocol(next)
              setError(null)
            }}
          />
          <Field label={t('name')} value={name} onChange={setName} placeholder="Okta" autoFocus={!connection} />
          {protocol === 'oidc' ? (
            <>
              <Field
                label={t('issuer')}
                value={issuer}
                onChange={setIssuer}
                placeholder="https://idp.example.com"
                mono
              />
              <div className="grid grid-cols-1 gap-3 desktop:grid-cols-2">
                <Field label={t('clientId')} value={clientId} onChange={setClientId} placeholder={t('clientId')} mono />
                {secretField}
              </div>
              <Field label={t('scopes')} value={scope} onChange={setScope} mono />
              <CopyField
                label={t('callbackUrl')}
                value={serviceProvider && 'redirectUri' in serviceProvider ? serviceProvider.redirectUri : null}
              />
            </>
          ) : (
            <>
              <div className="fld min-w-0">
                <Segments
                  label={t('metadata')}
                  value={source}
                  options={[
                    { value: 'url', label: t('metadataUrl') },
                    { value: 'xml', label: t('metadataXml') }
                  ]}
                  onChange={setSource}
                />
                {source === 'url' ? (
                  <div className="inp mn">
                    <input
                      className={INPUT}
                      aria-label={t('metadataUrl')}
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      value={metadataUrl}
                      placeholder="https://idp.example.com/metadata"
                      onChange={(event) => setMetadataUrl(event.target.value)}
                    />
                  </div>
                ) : (
                  <div className="inp mn items-start">
                    <textarea
                      className={`${INPUT} min-h-[76px] resize-y`}
                      aria-label={t('metadataXml')}
                      spellCheck={false}
                      value={metadata}
                      placeholder="<EntityDescriptor …>"
                      onChange={(event) => setMetadata(event.target.value)}
                    />
                  </div>
                )}
              </div>
              <div className="grid grid-cols-1 gap-3 desktop:grid-cols-2">
                <Field
                  label={t('emailAttribute')}
                  value={emailAttribute}
                  onChange={setEmailAttribute}
                  mono
                  suggestions={EMAIL_ATTRIBUTES}
                />
                <Field
                  label={t('nameAttribute')}
                  value={nameAttribute}
                  onChange={setNameAttribute}
                  mono
                  suggestions={NAME_ATTRIBUTES}
                />
              </div>
              <CopyField
                label={t('acsUrl')}
                value={
                  serviceProvider && 'entityId' in serviceProvider ? serviceProvider.assertionConsumerServiceUrl : null
                }
              />
              <CopyField
                label={t('entityId')}
                value={serviceProvider && 'entityId' in serviceProvider ? serviceProvider.entityId : null}
              />
            </>
          )}
          {error && (
            <div
              className="flex items-start gap-[6px] font-sans text-[12.5px] font-medium leading-[1.5] text-(--status-error)"
              role="alert"
            >
              <Icon name="circle-exclamation-point" size={14} className="mt-[2px] flex-none" />
              <span className="min-w-0 break-words">{error}</span>
            </div>
          )}
        </div>
        <div className="modalfoot">
          {connection && (
            <Button variant="ghost" className="text-(--status-error)" disabled={busy} onClick={onRemove}>
              {t('remove')}
            </Button>
          )}
          <div className="flex-1" />
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {tc('cancel')}
          </Button>
          <Button type="submit" disabled={busy || !ready}>
            {busy ? t('saving') : t('save')}
          </Button>
        </div>
      </form>
    </Scrim>
  )
}
