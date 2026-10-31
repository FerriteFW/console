<script lang="ts">
  // The place and radius for Airports and licensed sites: typed (lat,lon or a grid square) or from the radio (its GPS fix,
  // else its fixed position).
  import { library } from "../../library.svelte";
  import { radio } from "../../radio.svelte";

  const connected = $derived(radio.phase === "connected");
  const place = $derived(library.place);
  let asking = $state(false);

  async function fromRadio() {
    asking = true;
    try {
      await library.placeFromRadio();
    } finally {
      asking = false;
    }
  }
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
  <button class="btn" disabled={!connected || asking} onclick={fromRadio} title="The radio's GPS fix, else its fixed position (MENU 0 6 9)">
    {asking ? "Asking…" : "From radio"}
  </button>
  <label>
    <span class="label">Within</span>
    <select bind:value={library.radius} aria-label="Radius">
      {#each [10, 25, 50, 100, 200, 400] as r (r)}<option value={r}>{r} km</option>{/each}
    </select>
  </label>
  <span class="sub">
    {#if place}{library.placeFrom || `${place.lat.toFixed(4)}, ${place.lon.toFixed(4)}`} · {place.grid}{:else if library.placeText.trim()}<span class="bad">Not a place: lat, lon or a grid square (CN89, CN89kg)</span>{:else}Latitude, longitude or a grid square{/if}
  </span>
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
</style>
