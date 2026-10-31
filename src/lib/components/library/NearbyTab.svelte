<script lang="ts">
  // Near me: the place (PlacePicker), what to show (Licensed, Airports or Both; Canada and the US as sub-filters of
  // Licensed), then the map (the default) or the list. Only the kinds shown load, show and go in Add (nearby.svelte.ts).
  // The list for Both is the licensed groups, then the airports. When no place is given yet and a radio is
  // connected, its GPS fix (else its fixed position) is asked for once.
  import { library } from "../../library.svelte";
  import { radio } from "../../radio.svelte";
  import { airportSites, sites } from "../../sites.svelte";
  import { nearby, type Show } from "../../nearby.svelte";
  import PlacePicker from "./PlacePicker.svelte";
  import SitesTab from "./SitesTab.svelte";
  import AirportsTab from "./AirportsTab.svelte";
  import NearMap from "./NearMap.svelte";
  import AddBar from "./AddBar.svelte";
  import DataFooter from "./DataFooter.svelte";

  let { onadded }: { onadded: () => void } = $props();

  sites.start();
  airportSites.start();
  library.loadFixed();
  if (!library.placeText.trim() && radio.phase === "connected") library.placeFromRadio(true);

  $effect(() => {
    const p = library.place;
    const r = library.radius;
    if (!p) return;
    if (nearby.showLic) sites.look(p.lat, p.lon, r);
    if (nearby.showAir) airportSites.look(p.lat, p.lon, r);
  });

  const SHOW: { id: Show; label: string; title: string }[] = [
    { id: "lic", label: "Licensed", title: "Licensed VHF and UHF sites: Canada and the US" },
    { id: "air", label: "Airports", title: "Airports' airband frequencies: AM, RX only" },
    { id: "both", label: "Both", title: "Licensed sites and airports together" },
  ];
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
  const each = $derived(nearby.show === "lic" ? "One zone per name group" : nearby.show === "air" ? "One zone per airport" : "One zone per group or airport");
  const siteHere = $derived(new Set(nearby.siteAll.map((e) => e.src)));
  const airHere = $derived(new Set(nearby.airports.length ? ["airports"] : []));
</script>

<div class="top">
  <PlacePicker />
  <div class="seg" role="group" aria-label="View">
    <button aria-pressed={library.view === "map"} class:on={library.view === "map"} onclick={() => (library.view = "map")}>Map</button>
    <button aria-pressed={library.view === "list"} class:on={library.view === "list"} onclick={() => (library.view = "list")}>List</button>
  </div>
</div>
<div class="kinds">
  <div class="seg" role="group" aria-label="Show">
    {#each SHOW as k (k.id)}
      <button aria-pressed={nearby.show === k.id} class:on={nearby.show === k.id} onclick={() => (nearby.show = k.id)} title={k.title}>{k.label}</button>
    {/each}
  </div>
  {#if nearby.showLic}
    {#each SOURCES.filter((x) => counts[x.src]) as x (x.src)}
      <button class="chip" aria-pressed={on(x.src)} onclick={() => (nearby.layers = { ...nearby.layers, [x.src]: !on(x.src) })} title="Show or hide {x.label}'s licensed sites">
        <i class="dot"></i>{x.label} <span class="n">{counts[x.src]}</span>
      </button>
    {/each}
  {/if}
</div>
{#if library.view === "map"}
  <NearMap {each} {onadded} />
{:else}
  <div class="lists" class:both={nearby.show === "both"}>
    {#if nearby.showLic}<SitesTab />{/if}
    {#if nearby.showAir}<AirportsTab />{/if}
  </div>
  <AddBar {each} {onadded} />
  {#if nearby.showLic}<DataFooter data={sites} here={siteHere} inline={nearby.show === "both"} />{/if}
  {#if nearby.showAir}<DataFooter data={airportSites} here={airHere} inline={nearby.show === "both"} />{/if}
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
  .kinds .seg {
    margin-right: 6px;
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
