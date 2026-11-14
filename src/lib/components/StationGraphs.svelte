<script lang="ts">
  // Decision 397: a heard station's speed, altitude and weather over time, from what Console recorded while
  // connected (history.svelte.ts): one small chart a measure, only those the station sends.
  import { history, type Sample } from "../history.svelte";
  import LineChart from "./LineChart.svelte";

  let { call }: { call: string } = $props();

  const SERIES: { k: keyof Sample; title: string; unit: string; digits?: number }[] = [
    { k: "speed", title: "Speed", unit: "km/h" },
    { k: "alt", title: "Altitude", unit: "m" },
    { k: "temp", title: "Temperature", unit: "°C", digits: 1 },
    { k: "wind", title: "Wind", unit: "km/h", digits: 1 },
    { k: "gust", title: "Gusts", unit: "km/h", digits: 1 },
    { k: "hum", title: "Humidity", unit: "%" },
    { k: "hpa", title: "Pressure", unit: "hPa", digits: 1 },
    { k: "rain", title: "Rain, last hour", unit: "mm", digits: 1 },
  ];
  const samples = $derived(history.of(call));
  const charts = $derived(
    SERIES.map((s) => ({ ...s, points: samples.flatMap((p) => (p[s.k] === null ? [] : [{ t: p.t, v: p[s.k] as number }])) })).filter((s) => s.points.length > 0),
  );
</script>

<div class="graphs" data-k="graphs">
  {#if samples.length < 2}
    <p class="sub">
      {samples.length ? "One reading so far." : "No readings yet."} The radio keeps only the latest; Console records each one it sees while it is connected,
      for 3 days, and draws them here.
    </p>
  {/if}
  {#if samples.length}
    <div class="grid">
      {#each charts as c (c.k)}<LineChart title={c.title} unit={c.unit} digits={c.digits ?? 0} points={c.points} />{/each}
    </div>
  {/if}
</div>

<style>
  .graphs {
    padding: 8px 4px 12px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 14px 20px;
  }
</style>
