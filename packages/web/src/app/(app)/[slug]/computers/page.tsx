import { redirect } from 'next/navigation'

// Computers are a section of the Infra page now; keep old links landing on it.
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  redirect(`/${encodeURIComponent(slug)}/daemons#computers`)
}
