import { redirect } from 'next/navigation'

// Proxy normally rewrites this bare entry directly into the org-scoped tree.
// If the route is reached without that normalization, return to `/` so the
// signed-in user's server-stored organization preference can resolve it.
export default function HomeRedirect() {
  redirect('/')
}
