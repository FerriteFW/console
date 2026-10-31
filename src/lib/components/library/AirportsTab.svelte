<script lang="ts">
  // Airports near a place, as a list (OurAirports, tiled by 2-character field from data.ferritefw.dev:
  // sites.svelte.ts): their VHF airband frequencies with their uses, added as AM channels, RX only (Ferrite never
  // transmits on airband), named "ICAO TYPE" in 16 characters ("CYVR TWR 119.55" when an airport has two of a
  // type). An airport's box picks all its frequencies (the map picks them one by one; partly picked shows as such).
  // The rows and picks are nearby.svelte.ts's, shared with the map and the Licensed sites list; Add and the data
  // footer are Near me's (NearbyTab). The common frequencies not tied to an airport come from the fixed "Airband
  // (common)" set.
  import { library } from "../../library.svelte";
  import { airportSites as data } from "../../sites.svelte";
  import { nearby } from "../../nearby.svelte";

  const result = $derived(nearby.airportResult);
  const found = $derived(nearby.airports);
  const commonSet = $derived(nearby.commonSet);

  const failed = $derived(result?.failed ?? []);
  /** Nothing to show at all: the data couldn't be reached and nothing is kept. */
  const down = $derived(!!result && !result.sources.length && failed.length > 0);
  const total = $derived(data.listed[0]?.rows);
  const keys = (a: (typeof found)[number]) => a.freqs.map((q) => q.key);
</script>

{#if nearby.multi}<h3 class="kind">Airports</h3>{/if}
{#if !library.place}
  <p class="sub">
    {#if total}
      {total.toLocaleString()} airport frequencies worldwide (VHF airband). Give a place to list the airports near it.
    {:else if data.topError}
      Airports' VHF airband frequencies worldwide. Give a place to list the airports near it. (The data isn't reachable right now: {data.topError}.)
    {:else}
      Loading the airports' index…
    {/if}
  </p>
{:else if down}
  <div class="msg" role="status">
    <b>Airports aren't available right now.</b>
    <span>{failed[0].error}. Places you looked at before, and airports saved for offline, still work.</span>
    <button class="btn quiet sm" onclick={() => data.retry()}>Try again</button>
  </div>
{:else if !result}
  <p class="sub">Loading airports near the place…</p>
{:else}
  <div class="head">
    <span>{found.length} {found.length === 1 ? "airport" : "airports"} within {library.radius} km</span>
    <span class="spacer"></span>
    <button class="btn quiet sm" disabled={!found.length} onclick={() => nearby.set(found.flatMap(keys), true)}>All</button>
    <button class="btn quiet sm" onclick={() => nearby.set(found.flatMap(keys), false)}>None</button>
  </div>
  {#if failed.length}<p class="warn">{failed.map((f) => f.error).join(" · ")}</p>{/if}
  <div class="list" aria-label="Airports">
    {#each found as a (a.key)}
      {@const all = a.freqs.every((q) => nearby.has(q.key))}
      {@const some = a.freqs.some((q) => nearby.has(q.key))}
      <label class="ap" class:on={some}>
        <input type="checkbox" checked={all} indeterminate={some && !all} onchange={() => nearby.set(keys(a), !all)} aria-label={a.c} />
        <b class="icao">{a.c}</b>
        <span class="km">{a.km < 10 ? a.km.toFixed(1) : Math.round(a.km)} km</span>
        <span class="fs">
          {#each a.freqs as q (q.key)}<span class="chip" class:on={nearby.has(q.key)}><span class="mhz">{(q.khz / 1000).toFixed(3)}</span> {q.type}</span>{/each}
        </span>
      </label>
    {:else}
      <p class="sub pad">No airport with VHF frequencies within {library.radius} km.</p>
    {/each}
  </div>
{/if}
{#if commonSet}
  <label class="common"><input type="checkbox" bind:checked={nearby.common} /> Also the {commonSet.frequencies.length} common airband frequencies (emergency 121.5, air-to-air, multicom, en route: the Airband set)</label>
{/if}

<style>
  .kind {
    margin: 0;
    font-size: 12px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--sub);
  }
  .head {
    display: flex;
    gap: 6px;
    align-items: center;
    font-size: 12px;
    color: var(--sub);
  }
  .sm {
    padding: 3px 10px;
    font-size: 12px;
  }
  .list {
    flex: 1;
    min-height: 120px;
    overflow: auto;
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 4px;
  }
  .ap {
    display: grid;
    grid-template-columns: auto 64px 64px 1fr;
    gap: 10px;
    align-items: baseline;
    padding: 5px 6px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
  }
  .ap:hover {
    background: var(--raised);
  }
  .ap.on {
    background: var(--focus);
  }
  .km {
    color: var(--sub);
    font-size: 12px;
    text-align: right;
  }
  .fs {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 6px;
  }
  .chip {
    font-size: 11px;
    color: var(--sub);
    border: 1px solid var(--line);
    border-radius: 5px;
    padding: 0 5px;
  }
  .chip.on {
    border-color: var(--map-pick);
  }
  .mhz {
    color: var(--text);
  }
  .msg {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 10px;
    align-items: center;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: 8px;
    font-size: 13px;
  }
  .warn {
    margin: 0;
    font-size: 12px;
    color: var(--red);
  }
  .common {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 13px;
  }
  .spacer {
    flex: 1;
  }
  .sub {
    color: var(--sub);
    font-size: 12px;
  }
  .pad {
    padding: 12px;
  }
</style>
