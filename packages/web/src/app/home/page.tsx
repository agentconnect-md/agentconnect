import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

// The literal top-level `/home`. The console is org-scoped (`/{slug}/home`), so
// resolve the last-used org from the `ac.org` cookie (default: the seeded org
// `-`) and bounce into its Home. OrgProvider then reconciles an unknown/stale
// slug to a real org exactly as it does for any other console URL.
export default async function HomeRedirect() {
  const slug = (await cookies()).get('ac.org')?.value || '-'
  redirect(`/${slug}/home`)
}
