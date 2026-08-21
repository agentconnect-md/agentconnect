// Shared recharts config for the console's two spend charts (Usage's "Spend over time" and
// the Cluster page's Credits card), so a hue or a bucket label is defined once.

// SVG `fill` can't take a `var()` presentation attribute, so the bar hues are applied as
// descendant CSS rules on the chart wrapper (a real declaration out-ranks recharts' own `fill`
// attribute) — that keeps the bars theme-reactive with no JS reading computed styles. Literal
// strings so Tailwind can see them.
export const SEG_FILL = [
  '[&_.seg-0_path]:fill-(--chart-1)',
  '[&_.seg-1_path]:fill-(--chart-2)',
  '[&_.seg-2_path]:fill-(--chart-3)',
  '[&_.seg-3_path]:fill-(--chart-4)',
  '[&_.seg-4_path]:fill-(--chart-5)',
  '[&_.seg-5_path]:fill-(--chart-6)',
  '[&_.seg-6_path]:fill-(--chart-other)',
  '[&_.seg-flat_path]:fill-(--brand)',
  // recharts' accessibility layer makes the chart surface focusable, so clicking a bar leaves a
  // UA focus ring around the whole plot. Drop the default outline but keep a themed one for
  // :focus-visible, so keyboard users still see where focus is.
  '[&_.recharts-wrapper]:outline-none',
  '[&_.recharts-surface]:outline-none',
  '[&_.recharts-wrapper:focus-visible]:outline-2',
  '[&_.recharts-wrapper:focus-visible]:outline-offset-2',
  '[&_.recharts-wrapper:focus-visible]:outline-(--border-focus)',
  '[&_.recharts-surface:focus-visible]:outline-2',
  '[&_.recharts-surface:focus-visible]:outline-offset-2',
  '[&_.recharts-surface:focus-visible]:outline-(--border-focus)'
].join(' ')

// Buckets are aligned to the viewer's local day/hour (the CP flooring uses the tz offset we
// send), so `start` is the UTC instant of a local boundary — label it in local time to read as
// that local date/hour.
export function bucketLabel(iso: string, bucket: 'hour' | 'day'): string {
  const d = new Date(iso)
  return bucket === 'hour'
    ? `${String(d.getHours()).padStart(2, '0')}:00`
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** Label every Nth tick, so a 30-bucket axis does not print 30 dates. */
export const tickInterval = (buckets: number) => Math.max(1, Math.ceil(buckets / 8)) - 1
