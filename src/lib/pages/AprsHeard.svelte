<script lang="ts">
  // APRS › Heard stations: the radio's heard list (APRS-3, APRS-4; HEARD, LINK-44), newest first, kept current by
  // the subscription's events (LINK-46) while the page is open. Distance and bearing from the radio's own position
  // when it has one.
  import { ago, aprs, compass, distance, when, type HeardRow } from "../aprs.svelte";
  import { radio } from "../radio.svelte";
  import { href, mapHref } from "../route.svelte";
  import StationGraphs from "../components/StationGraphs.svelte";
  import { history } from "../history.svelte";

  let now = $state(Date.now());
  let search = $state("");
  // Decision 397: the station whose graphs are open
  let open = $state<string | null>(null);
  const connected = $derived(radio.phase === "connected");

  $effect(() => aprs.use());
  $effect(() => {
    if (connected) aprs.ensure();
  });
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 5000);
    return () => clearInterval(t);
  });

  const rows = $derived.by(() => {
    const q = search.trim().toLowerCase();
    return aprs.stations.filter((s) => !q || `${s.call} ${s.comment} ${s.path} ${s.symbol_name}`.toLowerCase().includes(q));
  });
  const away = (s: HeardRow) => {
    if (!aprs.me || s.lat === null || s.lon === null) return "";
    const d = distance(aprs.me, { lat: s.lat, lon: s.lon });
    return `${d.km < 10 ? d.km.toFixed(1) : Math.round(d.km)} km ${compass(d.deg)}`;
  };
</script>

<div class="pg">
  <div class="pg-bar" role="toolbar" aria-label="Heard stations">
    <div class="grp">
      <button class="btn" disabled={!connected || !!aprs.busy} onclick={() => aprs.refresh()}>Refresh</button>
      <a class="btn" href={href("aprs-map")}>Map</a>
    </div>
    <input type="search" placeholder="Find a station" aria-label="Find a station" bind:value={search} />
  </div>

  <div class="pg-status" aria-live="polite" data-status>
    {#if aprs.busy}
      <span>{aprs.busy}…</span>
    {:else if aprs.loaded}
      <span>{aprs.stations.length} heard{radio.subMask & 1 ? " · live" : ""}.</span>
      {#if aprs.me}<span>Distances from the radio ({aprs.me.from}: {aprs.me.lat.toFixed(4)}, {aprs.me.lon.toFixed(4)}).</span>
      {:else}<span>The radio has no position: no distances.</span>{/if}
    {:else if !connected}
      <span>Connect to see the stations the radio heard.</span>
    {/if}
  </div>
  {#if aprs.error}<div class="pg-banner">{aprs.error}</div>{/if}

  {#if aprs.loaded}
    <div class="pg-scroll">
      <table class="tbl" aria-label="Heard stations">
        <thead>
          <tr>
            <th>Station</th>
            <th>Symbol</th>
            <th>Last heard</th>
            <th>Distance</th>
            <th>Times</th>
            <th>Path</th>
            <th>Comment</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as s (s.call)}
            <tr data-call={s.call} class:fresh={s.at !== null && now - s.at < 10_000}>
              <td class="nowrap">
                {#if s.lat !== null}<a href={mapHref({ call: s.call })} title="On the map">{s.call}</a>{:else}{s.call}{/if}
                <a class="msg" href={href("aprs-messages", { to: s.call })} title={`Message ${s.call}`} aria-label={`Message ${s.call}`}>✉</a>
                <button
                  class="graph"
                  class:on={open === s.call}
                  aria-expanded={open === s.call}
                  title={`${s.call} over time (${history.of(s.call).length} readings recorded)`}
                  aria-label={`Graphs for ${s.call}`}
                  onclick={() => (open = open === s.call ? null : s.call)}>Graphs</button
                >
              </td>
              <td class="nowrap">{s.symbol_name}</td>
              <td class="nowrap" title={when(s.at)}>{ago(s.at, now)}</td>
              <td class="nowrap num">{away(s)}</td>
              <td class="num">{s.times}</td>
              <td>{s.path || "direct"}</td>
              <td>
                {s.comment}
                {#if s.speed !== null}<span class="dim"> · {s.speed} km/h {s.course}°</span>{/if}
                {#if s.alt_m !== null}<span class="dim"> · {s.alt_m} m</span>{/if}
              </td>
            </tr>
            {#if open === s.call}
              <tr class="graphs-row"><td colspan="7"><StationGraphs call={s.call} /></td></tr>
            {/if}
          {:else}
            <tr><td colspan="7" class="empty">{aprs.stations.length ? "No station matches." : "No stations heard yet."}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  a {
    color: var(--blue);
  }
  a.btn {
    color: var(--text);
    text-decoration: none;
  }
  .graph {
    margin-left: 6px;
    font: inherit;
    font-size: 12px;
    color: var(--sub);
    background: none;
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 0 5px;
    cursor: pointer;
  }
  .graph:hover,
  .graph.on {
    color: var(--blue);
    border-color: var(--blue);
  }
  .msg {
    margin-left: 6px;
    text-decoration: none;
    color: var(--sub);
  }
</style>
