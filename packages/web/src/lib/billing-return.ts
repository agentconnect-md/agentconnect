// The page that sent a reader to Billing to add credits (`/billing?return=`), so the console can take them back.

/** `value` when it is a path inside this org's console (`/<slug>/…`), else undefined — never another origin or org. */
export function billingReturnTarget(value: string | null | undefined, orgPrefix: string): string | undefined {
  if (!value || !orgPrefix.startsWith('/') || orgPrefix.length < 2) return undefined
  if (!value.startsWith(`${orgPrefix}/`) || /[\s\\]/.test(value)) return undefined
  // Collapsing dot segments must not climb out of the org: `/acme/../other` is another org's page.
  if (
    value
      .split(/[?#]/, 1)[0]!
      .split('/')
      .some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment))
  )
    return undefined
  return value
}

/** Billing's own path carrying the return target, for the links and hosted pages that come back to Billing. */
export function billingPathWithReturn(billingPath: string, returnTo: string | undefined): string {
  return returnTo ? `${billingPath}?return=${encodeURIComponent(returnTo)}` : billingPath
}
