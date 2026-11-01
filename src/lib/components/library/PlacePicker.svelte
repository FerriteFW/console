<script lang="ts">
  // The place and radius for Airports and licensed sites (list and map): typed (lat,lon or a grid square), from the
  // radio (its GPS fix, else its fixed position), or this computer's location ("Use my location": asked only on that
  // click, never on load). The desktop app on macOS has no location in its webview (wry doesn't pass WebKit's
  // geolocation through yet), so the button isn't there.
  import { canLocate, library } from "../../library.svelte";
  import { radio } from "../../radio.svelte";

  const connected = $derived(radio.phase === "connected");
  const place = $derived(library.place);
  /** The radius choices, plus the map's own (dragged or slid) when it isn't one. */
  const radii = $derived([...new Set([10, 25, 50, 100, 200, 400, library.radius])].sort((a, b) => a - b));
</script>

<div class="place">
  <label>
    <span class="label">Near</span>
    <input
      class="where"
      placeholder="49.2827, -123.1207 or CN89"
      bind:value={library.placeText}
      oninput={() => (library.placeFrom = "")}
      aria-label="Place: latitude, longitude or grid square"
    />
  </label>
  <button class="btn" disabled={!connected || !!library.asking} onclick={() => library.placeFromRadio()} title="The radio's GPS fix, else its fixed position (MENU 0 6 9)">
    {library.asking === "radio" ? "Asking…" : "From radio"}
  </button>
  {#if canLocate}
    <button class="btn" disabled={!!library.asking} onclick={() => library.placeFromBrowser()} title="This computer's location (the browser asks you first)">
      {library.asking === "browser" ? "Locating…" : "Use my location"}
    </button>
  {/if}
  <label>
    <span class="label">Within</span>
    <select bind:value={library.radius} aria-label="Radius">
      {#each radii as r (r)}<option value={r}>{r} km</option>{/each}
    </select>
  </label>
  <span class="sub">
    {#if place}{library.placeFrom || `${place.lat.toFixed(4)}, ${place.lon.toFixed(4)}`} · {place.grid}{:else if library.placeText.trim()}<span class="bad">Not a place: lat, lon or a grid square (CN89, CN89kg)</span>{:else}Latitude, longitude or a grid square{/if}
  </span>
  {#if library.locNote}<span class="note" role="status">{library.locNote}</span>{/if}
</div>

<style>
  .place {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 12px;
    align-items: center;
  }
  label {
    display: inline-flex;
    gap: 8px;
    align-items: center;
  }
  .where {
    width: 230px;
  }
  .where,
  select {
    font: inherit;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 7px;
    padding: 5px 8px;
  }
  .sub {
    color: var(--sub);
    font-size: 12px;
  }
  .bad {
    color: var(--red);
  }
  .note {
    flex-basis: 100%;
    color: var(--sub);
    font-size: 12px;
  }
</style>
