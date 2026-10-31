<script lang="ts">
  // Repeaters near a place, as a list (HearHam's operational analog FM repeaters on 2 m, 1.25 m and 70 cm, tiled by
  // 2-character field from data.ferritefw.dev: sites.svelte.ts): nearest first, each frequency with its offset and
  // tones. A repeater's box picks all its frequencies (the map picks them one by one; partly picked shows as such).
  // The search (shared with the map and the other lists) keeps a callsign or the start of the MHz. The rows and picks
  // are nearby.svelte.ts's; Add and the data footer are Near me's (NearbyTab).
  import { library } from "../../library.svelte";
  import { repeaterSites as data } from "../../sites.svelte";
  import { mhz, nearby, offsetLabel, toneLabel, type Repeater } from "../../nearby.svelte";

  const result = $derived(nearby.repeaterResult);
  /** The repeaters the search keeps, with only their matching frequencies. */
  const found = $derived.by((): Repeater[] => {
    if (!nearby.query.trim()) return nearby.repeaters;
    return nearby.repeaters.map((r) => ({ ...r, freqs: r.freqs.filter((q) => nearby.matchRepeater(r.c, q.f)) })).filter((r) => r.freqs.length);
  });

  const failed = $derived(result?.failed ?? []);
  /** Nothing to show at all: the data couldn't be reached and nothing is kept. */
  const down = $derived(!!result && !result.sources.length && failed.length > 0);
  const total = $derived(data.listed[0]?.rows);
  const keys = (r: Repeater) => r.freqs.map((q) => q.key);
  const km = (x: number) => (x < 10 ? x.toFixed(1) : String(Math.round(x)));
</script>

{#if nearby.multi}<h3 class="kind">Repeaters</h3>{/if}
{#if !library.place}
  <p class="sub">
    {#if total}
      {total.toLocaleString()} analog FM repeater frequencies worldwide (2 m, 1.25 m, 70 cm). Give a place to list the ones near it.
    {:else if data.topError}
      Analog FM repeaters worldwide. Give a place to list the ones near it. (The data isn't reachable right now: {data.topError}.)
    {:else}
      Loading the repeaters' index…
    {/if}
  </p>
{:else if down}
  <div class="msg" role="status">
    <b>Repeaters aren't available right now.</b>
    <span>{failed[0].error}. Places you looked at before, and repeaters saved for offline, still work.</span>
    <button class="btn quiet sm" onclick={() => data.retry()}>Try again</button>
  </div>
{:else if !result}
  <p class="sub">Loading repeaters near the place…</p>
{:else}
  <div class="head">
    {#if !nearby.showLic}<input class="find" type="search" placeholder="Search: callsign or MHz" bind:value={nearby.query} aria-label="Filter repeaters" />{/if}
    <span>{found.length} {found.length === 1 ? "repeater" : "repeaters"} within {library.radius} km{nearby.query.trim() ? " matching" : ""}</span>
    <span class="spacer"></span>
    <button class="btn quiet sm" disabled={!found.length} onclick={() => nearby.set(found.flatMap(keys), true)}>All</button>
    <button class="btn quiet sm" onclick={() => nearby.set(nearby.repeaters.flatMap(keys), false)}>None</button>
  </div>
  {#if failed.length}<p class="warn">{failed.map((f) => f.error).join(" · ")}</p>{/if}
  <div class="list" aria-label="Repeaters near the place">
    {#each found as r (r.key)}
      {@const all = r.freqs.every((q) => nearby.has(q.key))}
      {@const some = r.freqs.some((q) => nearby.has(q.key))}
      <label class="rp" class:on={some}>
        <input type="checkbox" checked={all} indeterminate={some && !all} onchange={() => nearby.set(keys(r), !all)} aria-label={r.c} />
        <b class="call">{r.c}</b>
        <span class="km">{km(r.km)} km</span>
        <span class="fs">
          {#each r.freqs as q (q.key)}
            <span class="chip" class:on={nearby.has(q.key)}><span class="mhz">{mhz(q.f)}</span> {offsetLabel(q.d)} · {toneLabel(q.te, q.td)}</span>
          {/each}
        </span>
      </label>
    {:else}
      <p class="sub pad">No repeater within {library.radius} km{nearby.query.trim() ? " matches" : ""}.</p>
    {/each}
  </div>
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
    gap: 8px;
    align-items: center;
    font-size: 12px;
    color: var(--sub);
  }
  .find {
    width: 240px;
    font: inherit;
    font-size: 13px;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 7px;
    padding: 4px 8px;
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
  .rp {
    display: grid;
    grid-template-columns: auto 96px 64px 1fr;
    gap: 10px;
    align-items: baseline;
    padding: 5px 6px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
  }
  .rp:hover {
    background: var(--raised);
  }
  .rp.on {
    background: var(--focus);
  }
  .call {
    overflow-wrap: anywhere;
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
