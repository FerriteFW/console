<script lang="ts">
  // Near me: the place (PlacePicker), Canada and the US as sub-filters of Licensed, then the map (the default) or the
  // list. The kinds shown (Licensed, Airports, Repeaters) are switched in the dialog's sidebar (LibraryDialog, which
  // also loads them); only those show and go in Add (nearby.svelte.ts). The list with several kinds is the licensed
  // groups, then the airports, then the repeaters. When no place is given yet and a radio is connected, its GPS fix
  // (else its fixed position) is asked for once. With `ontune` (Live View's Tune from map) it is the map alone.
  import { library } from "../../library.svelte";
  import { radio } from "../../radio.svelte";
  import { airportSites, repeaterSites, sites } from "../../sites.svelte";
  import { nearby } from "../../nearby.svelte";
  import PlacePicker from "./PlacePicker.svelte";
  import SitesTab from "./SitesTab.svelte";
  import AirportsTab from "./AirportsTab.svelte";
  import RepeatersTab from "./RepeatersTab.svelte";
  import NearMap from "./NearMap.svelte";
  import AddBar from "./AddBar.svelte";
  import DataCredits from "./DataCredits.svelte";
  import type { Tune } from "../../tune";

  let { onadded, ontune }: { onadded: () => void; ontune?: (t: Tune) => void } = $props();

  sites.start();
  airportSites.start();
  repeaterSites.start();
  library.loadFixed();
  if (!library.placeText.trim() && radio.phase === "connected") library.placeFromRadio(true);
  const SOURCES = [
    { src: "tafl", label: "Canada" },
    { src: "fcc", label: "US" },
  ];
  /** Licensed sites per source near the place (a name at a position), whether switched on or not. */
  const counts = $derived.by(() => {
    const c: Record<string, number> = {};
    const seen = new Set<string>();
    for (const e of nearby.siteAll) {
      const id = `${e.src}|${e.name}|${e.pos}`;
      if (seen.has(id)) continue;
      seen.add(id);
      c[e.src] = (c[e.src] ?? 0) + 1;
    }
    return c;
  });
  const on = (src: string) => nearby.layers[src] !== false;
  /** The zone target's "each" choice for the kinds shown: repeaters all go in one "Repeaters" zone. */
  const each = $derived.by(() => {
    const per = [nearby.showLic ? "organization" : "", nearby.showAir ? "airport" : ""].filter(Boolean);
    const one = per.length ? `One zone per ${per.join(" or ")}` : "";
    if (!nearby.showRpt) return one;
    return one ? `${one}, one for repeaters` : `One zone: "Repeaters"`;
  });
  const siteHere = $derived(new Set(nearby.siteAll.map((e) => e.src)));
  const airHere = $derived(new Set(nearby.airports.length ? ["airports"] : []));
  const rptHere = $derived(new Set(nearby.repeaters.length ? ["repeaters"] : []));
  const chips = $derived(nearby.showLic ? SOURCES.filter((x) => counts[x.src]) : []);
</script>

<div class="top">
  <PlacePicker />
  {#if !ontune}
  <div class="seg" role="group" aria-label="View">
    <button aria-pressed={library.view === "map"} class:on={library.view === "map"} onclick={() => (library.view = "map")}>Map</button>
    <button aria-pressed={library.view === "list"} class:on={library.view === "list"} onclick={() => (library.view = "list")}>List</button>
  </div>
  {/if}
</div>
{#if chips.length}
  <div class="kinds" role="group" aria-label="Licensed sources">
    {#each chips as x (x.src)}
      <button class="chip" aria-pressed={on(x.src)} onclick={() => (nearby.layers = { ...nearby.layers, [x.src]: !on(x.src) })} title="Show or hide {x.label}'s licensed sites">
        <i class="dot"></i>{x.label} <span class="n">{counts[x.src]}</span>
      </button>
    {/each}
  </div>
{/if}
{#if ontune}
  <NearMap {ontune} />
{:else if library.view === "map"}
  <NearMap {each} {onadded} />
{:else}
  <div class="lists" class:both={nearby.multi}>
    {#if nearby.showRpt}<RepeatersTab />{/if}
    {#if nearby.showLic}<SitesTab />{/if}
    {#if nearby.showAir}<AirportsTab />{/if}
  </div>
  <AddBar {each} {onadded} />
  <DataCredits
    shown={[
      ...(nearby.showRpt ? [{ data: repeaterSites, here: rptHere }] : []),
      ...(nearby.showLic ? [{ data: sites, here: siteHere }] : []),
      ...(nearby.showAir ? [{ data: airportSites, here: airHere }] : []),
    ]}
  />
{/if}

<style>
  .top {
    display: flex;
    gap: 8px 12px;
    align-items: flex-start;
  }
  .top > :global(.place) {
    flex: 1;
    min-width: 0;
  }
  .kinds {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 8px;
    align-items: center;
    font-size: 12px;
  }
  .seg {
    display: inline-flex;
    flex: none;
    border: 1px solid var(--line);
    border-radius: 7px;
    overflow: hidden;
  }
  .seg button {
    font: inherit;
    font-size: 13px;
    background: none;
    border: none;
    color: var(--sub);
    padding: 5px 14px;
    cursor: pointer;
  }
  .seg button + button {
    border-left: 1px solid var(--line);
  }
  .seg button.on {
    background: var(--blue);
    color: var(--blue-fg);
  }
  .chip {
    font: inherit;
    display: inline-flex;
    gap: 6px;
    align-items: center;
    background: var(--raised);
    color: var(--text);
    border: 1px solid var(--line);
    border-radius: 7px;
    padding: 3px 9px;
    cursor: pointer;
  }
  .chip[aria-pressed="false"] {
    color: var(--sub);
    background: none;
  }
  .chip .n {
    color: var(--sub);
  }
  .dot {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--map-lic);
  }
  .chip[aria-pressed="false"] .dot {
    background: none;
    border: 1.5px solid var(--sub);
  }
  .lists {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .lists.both {
    overflow: auto;
  }
  .lists.both :global(.list) {
    flex: none;
    max-height: none;
    overflow: visible;
  }
</style>
