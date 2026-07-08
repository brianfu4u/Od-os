/**
 * Decorative tempo sparkline. It is chrome, not data — a gentle deterministic wave
 * anchored to the current score so the cockpit reads as "live" without implying a
 * fabricated history. Real time-series trends are a later analytics ticket.
 */
export function Sparkline({ score }: { score: number }) {
  const n = 24;
  const pts = Array.from({ length: n }, (_, i) => {
    const wave = Math.sin(i / 2.3) * 6 + Math.sin(i / 5.7) * 3;
    const y = Math.max(4, Math.min(56, 60 - (score * 0.5 + 8) - wave));
    const x = (i / (n - 1)) * 160;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const stroke = score >= 80 ? '#34d399' : score >= 55 ? '#38bdf8' : '#fbbf24';
  return (
    <svg viewBox="0 0 160 60" className="h-12 w-40" preserveAspectRatio="none" aria-hidden>
      <polyline
        points={pts.join(' ')}
        fill="none"
        stroke={stroke}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
