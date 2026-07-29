export const dynamic = 'force-dynamic'

// Logto's public sign-in-experience endpoint intentionally omits browser CORS
// headers. Keep the browser request same-origin and forward only the connector
// metadata it needs; Account API tokens still go directly from browser to Logto.
function logtoConfig(): { endpoint: string; appId: string } | undefined {
  const endpoint = process.env.LOGTO_ENDPOINT ?? process.env.NEXT_PUBLIC_LOGTO_ENDPOINT
  const appId = process.env.LOGTO_APP_ID ?? process.env.NEXT_PUBLIC_LOGTO_APP_ID
  return endpoint && appId ? { endpoint, appId } : undefined
}

export async function GET() {
  const config = logtoConfig()
  if (!config) {
    return Response.json({ message: 'Social sign-in methods are not configured.' }, { status: 503 })
  }

  try {
    const url = new URL('/api/.well-known/experience', config.endpoint)
    url.searchParams.set('appId', config.appId)
    const upstream = await fetch(url, { next: { revalidate: 60 } })
    if (!upstream.ok) throw new Error(`Logto experience returned ${upstream.status}`)

    const body = (await upstream.json()) as { socialConnectors?: unknown }
    return Response.json(
      { socialConnectors: Array.isArray(body.socialConnectors) ? body.socialConnectors : [] },
      { headers: { 'Cache-Control': 'public, max-age=60, stale-while-revalidate=300' } }
    )
  } catch {
    return Response.json({ message: 'Social sign-in methods are temporarily unavailable.' }, { status: 502 })
  }
}
