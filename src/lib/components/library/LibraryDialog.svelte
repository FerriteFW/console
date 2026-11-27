<script lang="ts">
  // "Add channels": the channel library beside CHIRP import. Fixed sets; Near me: licensed sites, airports and
  // repeaters near a place (ported from NeonPlug), on the map or as a list (NearbyTab). Near me's kinds sit under it
  // in the sidebar, always in view: each a switch (any of them, at least one: nearby.svelte.ts), with how many are
  // near the place; one clicked from another tab opens Near me with it on. Under Business & public (licensed sites),
  // while it shows, its categories are switches too (Business off to start: the map's noise). The dialog is always nearly as big as the
  // window (a desktop app's feel: the map gets the room), so switching tabs never resizes it.
  // Added channels go into the table as new rows, checked by ferrite's own code; Write then shows them in the diff
  // as usual. Live View's Tune from map (library.mode "tune") is the same dialog with Near me's map alone: a frequency
  // clicked tunes the radio's active slot (library.tune) and the dialog closes.
  import { recentTunes } from "../../recentTunes.svelte";
  import { library } from "../../library.svelte";
  import FixedTab from "./FixedTab.svelte";
  import NearbyTab from "./NearbyTab.svelte";
  import { channels } from "../../channels.svelte";
  import { P } from "../../core";
  import { airportSites, repeaterSites, sites } from "../../sites.svelte";
  import { CAT_ORDER, nearby, type Kind } from "../../nearby.svelte";
  import { CATEGORIES } from "../../sitedata";
  import type { Tune } from "../../tune";

  const tabs = [
    { id: "fixed", label: "Fixed sets", sub: "By region: calling, licence-free, marine, weather, airband, satellites" },
    { id: "near", label: "Near me", sub: "What's near a place, on a map" },
  ] as const;
  const KINDS: { id: Kind; label: string; what: [string, string] }[] = [
    { id: "rpt", label: "Repeaters", what: ["repeater", "repeaters"] },
    { id: "lic", label: "Business & public", what: ["licensed frequency", "licensed frequencies"] },
    { id: "air", label: "Airports", what: ["airport", "airports"] },
  ];

  // Near me's data loads while the dialog is open and a place is given, so the sidebar can count it: airports and
  // repeaters (small) always, licensed sites when shown (their tiles are big).
  $effect(() => {
    const p = library.place;
    const r = library.radius;
    if (!library.open || !p) return;
    if (nearby.showLic) sites.look(p.lat, p.lon, r);
    airportSites.look(p.lat, p.lon, r);
    repeaterSites.look(p.lat, p.lon, r);
  });
  /** How many of a kind are near the place, once loaded. */
  function count(k: Kind): number | null {
    if (k === "lic") return nearby.siteResult ? nearby.siteShown.length : null;
    if (k === "air") return nearby.airportResult ? nearby.airports.length : null;
    return nearby.repeaterResult ? nearby.repeaters.length : null;
  }
  function kindTitle(k: (typeof KINDS)[number], n: number | null) {
    const on = nearby.kinds.has(k.id);
    const what = n === null ? "" : `${n} ${k.what[n === 1 ? 0 : 1]} within ${library.radius} km. `;
    return what + (on && nearby.kinds.size === 1 ? "At least one kind shows" : on ? `Click to hide ${k.label.toLowerCase()}` : `Click to show ${k.label.toLowerCase()}`);
  }
  function pickKind(k: Kind) {
    if (library.tab !== "near") {
      library.tab = "near";
      nearby.setKind(k, true);
    } else nearby.toggleKind(k);
  }

  const room = $derived(P.limits.channels - channels.table.channels.length);
  const close = () => (library.open = false);
  const tuneMode = $derived(library.mode === "tune");
  async function tune(t: Tune) {
    if (await recentTunes.tune(t)) close();
  }
  function key(e: KeyboardEvent) {
    if (e.key === "Escape" && library.open) close();
  }
</script>

<svelte:window onkeydown={key} />

{#if library.open}
  <div class="overlay" role="presentation" onclick={(e) => e.target === e.currentTarget && close()}>
    <div class="dialog card" role="dialog" aria-modal="true" aria-labelledby="lib-title">
      <header>
        {#if tuneMode}
          <h2 id="lib-title">Tune from map</h2>
          <span class="sub">{library.tuning ? "Tuning…" : "Click a frequency: the radio's active slot tunes to it as a VFO (no channel saved)."}</span>
        {:else}
          <h2 id="lib-title">Add channels</h2>
          <span class="sub">{channels.table.channels.length} in the table · room for {room} more · {channels.table.zones.length} zones</span>
        {/if}
        <span class="spacer"></span>
        <button class="x" onclick={close} aria-label="Close">✕</button>
      </header>
      <div class="body">
        <div class="nav" role="tablist" aria-label="Sources">
          {#each tuneMode ? tabs.filter((t) => t.id === "near") : tabs as t (t.id)}
            <button role="tab" aria-selected={library.tab === t.id} class:on={library.tab === t.id} onclick={() => (library.tab = t.id)}>
              <b>{t.label}</b><span>{t.sub}</span>
            </button>
          {/each}
          <div class="kinds" role="group" aria-label="Near me shows">
            {#each KINDS as k (k.id)}
              {@const n = count(k.id)}
              <button class="kind {k.id}" aria-pressed={nearby.kinds.has(k.id)} onclick={() => pickKind(k.id)} title={kindTitle(k, n)}>
                <i class="box" aria-hidden="true"></i><span class="name">{k.label}</span>{#if n !== null && library.place}<span class="n">{n.toLocaleString()}</span>{/if}
              </button>
              {#if k.id === "lic" && nearby.showLic}
                <div class="cats" role="group" aria-label="Business and public categories">
                  {#each CAT_ORDER as c (c)}
                    {@const on = !nearby.catsOff.has(c)}
                    {@const cn = nearby.siteResult ? (nearby.catCounts.get(c) ?? 0) : null}
                    <button class="kind cat" aria-pressed={on} onclick={() => nearby.toggleCat(c)} title="{on ? 'Hide' : 'Show'} {CATEGORIES[c].toLowerCase()}">
                      <i class="box" aria-hidden="true"></i><span class="name">{CATEGORIES[c]}</span>{#if cn !== null && library.place}<span class="n">{cn.toLocaleString()}</span>{/if}
                    </button>
                  {/each}
                </div>
              {/if}
            {/each}
          </div>
          {#if tuneMode}
            <p class="note">A repeater tunes with its shift and tones; an airport in NAM (narrow AM). To keep a frequency, add it as a channel on Channels &amp; Zones.</p>
          {:else}
            <p class="note">Added channels land in the table as new rows (green). Nothing goes to the radio until Write, which backs up and shows the diff first.</p>
          {/if}
        </div>
        <div class="panel" role="tabpanel" aria-label={tabs.find((t) => t.id === library.tab)?.label}>
          {#if library.error}<div class="banner">{library.error}</div>{/if}
          {#if tuneMode}
            <NearbyTab onadded={close} ontune={tune} />
          {:else if library.tab === "fixed"}
            <FixedTab onadded={close} />
          {:else}
            <NearbyTab onadded={close} />
          {/if}
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgb(0 0 0 / 0.55);
    display: grid;
    place-items: center;
    z-index: 20;
    padding: 16px;
  }
  .dialog {
    width: min(96vw, calc(100vw - 32px), 1800px);
    height: min(92vh, calc(100vh - 32px), 1200px);
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 14px 16px;
  }
  header {
    display: flex;
    gap: 12px;
    align-items: baseline;
  }
  h2 {
    margin: 0;
    font-size: 17px;
  }
  .spacer {
    flex: 1;
  }
  .x {
    background: none;
    border: none;
    color: var(--sub);
    cursor: pointer;
    font-size: 16px;
    padding: 2px 6px;
    border-radius: 5px;
  }
  .x:hover {
    color: var(--text);
    background: var(--raised);
  }
  .body {
    display: grid;
    grid-template-columns: 220px 1fr;
    gap: 16px;
    flex: 1;
    min-height: 0;
  }
  .nav {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .nav button {
    text-align: left;
    background: none;
    border: 1px solid transparent;
    border-left: 3px solid transparent;
    border-radius: 6px;
    padding: 8px 10px;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .nav button span {
    color: var(--sub);
    font-size: 11px;
    line-height: 1.3;
  }
  .nav button:hover {
    background: var(--raised);
  }
  .nav button.on {
    background: var(--focus);
    border-left-color: var(--blue);
  }
  /* Near me's kinds: indented under it, each a switch with its count. */
  .kinds {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: -2px 0 4px 14px;
    padding-left: 8px;
    border-left: 1px solid var(--line);
  }
  .nav .kind {
    flex-direction: row;
    align-items: center;
    gap: 8px;
    padding: 5px 8px;
    border: none;
    font: inherit;
    font-size: 13px;
    color: var(--sub);
  }
  .nav .kind[aria-pressed="true"] {
    color: var(--text);
  }
  .kind .name {
    flex: 1;
    color: inherit;
    font-size: 13px;
  }
  .nav .kind .n {
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .box {
    flex: none;
    width: 14px;
    height: 14px;
    border-radius: 4px;
    border: 1.5px solid var(--sub);
    display: grid;
    place-items: center;
  }
  .kind[aria-pressed="true"] .box {
    border-color: transparent;
    background: var(--k);
  }
  .kind[aria-pressed="true"] .box::after {
    content: "";
    width: 7px;
    height: 4px;
    margin-top: -2px;
    border: solid #fff;
    border-width: 0 0 2px 2px;
    transform: rotate(-45deg);
  }
  .cats {
    display: flex;
    flex-direction: column;
    margin: 0 0 4px 14px;
    padding-left: 6px;
    border-left: 1px solid var(--line);
  }
  .nav .kind.cat {
    padding: 3px 8px;
    gap: 7px;
  }
  .kind.cat .name,
  .nav .kind.cat .n {
    font-size: 12px;
  }
  .kind.cat .box {
    width: 12px;
    height: 12px;
    border-radius: 3px;
  }
  .kind.cat {
    --k: var(--map-lic);
  }
  .kind.lic {
    --k: var(--map-lic);
  }
  .kind.air {
    --k: var(--map-air);
  }
  .kind.rpt {
    --k: var(--map-rpt);
  }
  .note {
    margin-top: auto;
    color: var(--sub);
    font-size: 11px;
    line-height: 1.4;
  }
  .panel {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-height: 0;
    min-width: 0;
  }
  .banner {
    padding: 6px 10px;
    border: 1px solid var(--red);
    border-radius: 8px;
    color: var(--red);
    font-size: 13px;
  }
  .sub {
    color: var(--sub);
    font-size: 12px;
  }
  @media (max-width: 760px) {
    .dialog {
      height: calc(100vh - 32px);
    }
    .body {
      grid-template-columns: 1fr;
      grid-template-rows: auto 1fr;
    }
    .nav,
    .kinds {
      flex-direction: row;
      overflow-x: auto;
    }
    .kinds {
      margin: 0;
      border-left: none;
    }
    .nav button span,
    .note {
      display: none;
    }
  }
</style>
