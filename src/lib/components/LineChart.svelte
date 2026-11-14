<script lang="ts">
  // One measure over time (decision 397's station graphs): one series, one axis, its name in the title, so no
  // legend. A 2 px line, broken where readings are more than 3 h apart (a reading alone: a dot); a crosshair and a
  // readout on hover.
  let { title, unit, points, digits = 0 }: { title: string; unit: string; points: { t: number; v: number }[]; digits?: number } = $props();

  const W = 380;
  const H = 130;
  const PAD = { l: 40, r: 8, t: 8, b: 22 };
  const GAP_MS = 3 * 3_600_000;

  const span = $derived.by(() => {
    const ts = points.map((p) => p.t);
    const vs = points.map((p) => p.v);
    let lo = Math.min(...vs);
    let hi = Math.max(...vs);
    if (lo === hi) [lo, hi] = [lo - 1, hi + 1];
    const pad = (hi - lo) * 0.08;
    return { t0: Math.min(...ts), t1: Math.max(...ts), lo: lo - pad, hi: hi + pad };
  });
  const x = (t: number) => PAD.l + (span.t1 === span.t0 ? 0.5 : (t - span.t0) / (span.t1 - span.t0)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v - span.lo) / (span.hi - span.lo)) * (H - PAD.t - PAD.b);
  // runs of readings close enough to join; a run of one is a dot
  const runs = $derived.by(() => {
    const out: { t: number; v: number }[][] = [];
    points.forEach((p, i) => {
      if (i === 0 || p.t - points[i - 1].t > GAP_MS) out.push([]);
      out[out.length - 1].push(p);
    });
    return out;
  });
  const path = (r: { t: number; v: number }[]) => r.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const ticks = $derived([span.lo + (span.hi - span.lo) * 0.08, (span.lo + span.hi) / 2, span.hi - (span.hi - span.lo) * 0.08]);
  const fmt = (v: number) => v.toFixed(digits);
  const time = (t: number) => {
    const d = new Date(t);
    const today = new Date().toDateString() === d.toDateString();
    return d.toLocaleString([], today ? { hour: "2-digit", minute: "2-digit" } : { weekday: "short", hour: "2-digit", minute: "2-digit" });
  };

  let hover = $state<{ t: number; v: number } | null>(null);
  function move(e: PointerEvent) {
    const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let best = points[0];
    for (const p of points) if (Math.abs(x(p.t) - px) < Math.abs(x(best.t) - px)) best = p;
    hover = best;
  }
  const last = $derived(points[points.length - 1]);
</script>

<figure class="chart">
  <figcaption>
    <span class="t">{title}</span>
    <span class="v" aria-live="polite">{hover ? `${fmt(hover.v)} ${unit} · ${time(hover.t)}` : `${fmt(last.v)} ${unit} now`}</span>
  </figcaption>
  <svg viewBox="0 0 {W} {H}" role="img" aria-label={`${title}: ${points.length} readings, last ${fmt(last.v)} ${unit}`} onpointermove={move} onpointerleave={() => (hover = null)}>
    {#each ticks as v (v)}
      <line class="grid" x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} />
      <text class="ax" x={PAD.l - 6} y={y(v) + 4} text-anchor="end">{fmt(v)}</text>
    {/each}
    <text class="ax" x={PAD.l} y={H - 6}>{time(span.t0)}</text>
    <text class="ax" x={W - PAD.r} y={H - 6} text-anchor="end">{time(span.t1)}</text>
    {#each runs as r, i (i)}
      {#if r.length > 1}<path class="line" d={path(r)} />{:else}<circle class="dot" cx={x(r[0].t)} cy={y(r[0].v)} r="4" />{/if}
    {/each}
    {#if hover}
      <line class="cross" x1={x(hover.t)} x2={x(hover.t)} y1={PAD.t} y2={H - PAD.b} />
      <circle class="dot" cx={x(hover.t)} cy={y(hover.v)} r="4" />
    {/if}
  </svg>
</figure>

<style>
  .chart {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  figcaption {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    font-size: 13px;
  }
  .t {
    color: var(--text);
  }
  .v {
    color: var(--sub);
    font-variant-numeric: tabular-nums;
  }
  svg {
    width: 100%;
    height: auto;
    touch-action: none;
  }
  .grid {
    stroke: var(--line);
    stroke-width: 1;
  }
  .ax {
    fill: var(--sub);
    font-size: 11px;
  }
  .line {
    fill: none;
    stroke: var(--blue);
    stroke-width: 2;
    stroke-linejoin: round;
    stroke-linecap: round;
  }
  .cross {
    stroke: var(--sub);
    stroke-width: 1;
    stroke-dasharray: 3 3;
  }
  .dot {
    fill: var(--blue);
    stroke: var(--surface);
    stroke-width: 2;
  }
</style>
