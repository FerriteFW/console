<script lang="ts">
  // Airports and Licensed sites: the place (PlacePicker), then the map (the default) or the tab's list. The map shows
  // every layer at once (Canada, the US, airports), so it loads both data sets; a list loads only its own. When no
  // place is given yet and a radio is connected, its GPS fix (else its fixed position) is asked for once.
  import { library } from "../../library.svelte";
  import { radio } from "../../radio.svelte";
  import { airportSites, sites } from "../../sites.svelte";
  import PlacePicker from "./PlacePicker.svelte";
  import SitesTab from "./SitesTab.svelte";
  import AirportsTab from "./AirportsTab.svelte";
  import NearMap from "./NearMap.svelte";

  let { tab, onadded }: { tab: "sites" | "airports"; onadded: () => void } = $props();

  sites.start();
  airportSites.start();
  library.loadFixed();
  if (!library.placeText.trim() && radio.phase === "connected") library.placeFromRadio(true);

  $effect(() => {
    const p = library.place;
    const r = library.radius;
    const map = library.view === "map";
    if (!p) return;
    if (map || tab === "sites") sites.look(p.lat, p.lon, r);
    if (map || tab === "airports") airportSites.look(p.lat, p.lon, r);
  });
</script>

<div class="top">
  <PlacePicker />
  <div class="seg" role="group" aria-label="View">
    <button aria-pressed={library.view === "map"} class:on={library.view === "map"} onclick={() => (library.view = "map")}>Map</button>
    <button aria-pressed={library.view === "list"} class:on={library.view === "list"} onclick={() => (library.view = "list")}>List</button>
  </div>
</div>
{#if library.view === "map"}
  <NearMap {onadded} />
{:else if tab === "sites"}
  <SitesTab {onadded} />
{:else}
  <AirportsTab {onadded} />
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
</style>
