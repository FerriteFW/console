<script lang="ts">
  // SAT-23 (decision 395): the picked satellite on the map: where it is now, its ground track for the next two orbits,
  // the area that can hear it, and its next pass over the place set in Near me. The radio's own SGP4 (core satmap.rs),
  // so the map and the radio agree. Moves every 15 s.
  import { satMap, type SatMap, type SatRow } from "../core";
  import { library } from "../library.svelte";
  import { ATTRIBUTION, loadLeaflet, NO_TILES, TILES, type Leaflet, type LLayer, type LMap } from "../leaflet";

  let { sat }: { sat: SatRow } = $props();

  let el: HTMLDivElement;
  let map: LMap | null = $state(null);
  let L: Leaflet | null = $state(null);
  let mapError = $state("");
  let now = $state(Math.floor(Date.now() / 1000));
  let layers: LLayer[] = [];
  let fittedFor = 0;

  $effect(() => {
    const t = setInterval(() => (now = Math.floor(Date.now() / 1000)), 15_000);
    return () => clearInterval(t);
  });

  $effect(() => {
    let gone = false;
    loadLeaflet()
      .then((l) => {
        if (gone) return;
        map = l.map(el, { worldCopyJump: true, minZoom: 1 }).setView([20, 0], 1);
        if (!NO_TILES) l.tileLayer(TILES, { maxZoom: 10, attribution: ATTRIBUTION }).addTo(map);
        L = l;
      })
      .catch((e) => (mapError = (e as Error).message));
    return () => {
      gone = true;
      map?.remove();
      map = null;
    };
  });

  const place = $derived(library.place);
  const where = $derived.by((): { m: SatMap | null; error: string } => {
    try {
      return { m: satMap(Uint8Array.from(sat.record), now, place), error: "" };
    } catch (e) {
      return { m: null, error: (e as Error).message };
    }
  });

  $effect(() => {
    const l = L;
    const m = map;
    const w = where.m;
    if (!l || !m) return;
    for (const x of layers) x.remove();
    layers = [];
    if (!w) return;
    for (const piece of w.track) {
      if (piece.length > 1) layers.push(l.polyline(piece.map((p) => [p.lat, p.lon]), { color: "#4da3ff", weight: 2, opacity: 0.8, interactive: false }).addTo(m));
    }
    layers.push(l.circle([w.now.lat, w.now.lon], { radius: w.footprint_km * 1000, color: "#4da3ff", weight: 1, fillOpacity: 0.08, interactive: false }).addTo(m));
    layers.push(
      l
        .circleMarker([w.now.lat, w.now.lon], { radius: 7, color: "#0057c2", weight: 2, fillColor: "#4da3ff", fillOpacity: 1 })
        .bindTooltip(`${sat.short} now, ${Math.round(w.alt_km)} km up`)
        .addTo(m),
    );
    if (place) layers.push(l.circleMarker([place.lat, place.lon], { radius: 5, color: "#1f8a3a", weight: 2, fillColor: "#5cd97a", fillOpacity: 1 }).bindTooltip("Near me").addTo(m));
    // a new satellite: centre on it, the whole world in view
    if (fittedFor !== sat.id) {
      fittedFor = sat.id;
      m.setView([Math.max(-60, Math.min(60, w.now.lat)), w.now.lon], 1);
    }
  });

  const hm = (t: number) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const day = (t: number) => {
    const d = new Date(t * 1000);
    const today = new Date();
    return d.toDateString() === today.toDateString() ? "today" : d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  };
  const pass = $derived.by(() => {
    const n = where.m?.next;
    if (!place) return "Set a place in Near me (Channels › Add channels) for the next pass over it.";
    if (!n) return "No pass over the place in the next two days.";
    const up = n.aos <= now;
    return `${up ? "Up now" : `Next pass ${day(n.aos)} ${hm(n.aos)}`}–${hm(n.los)}, highest ${Math.round(n.max_el)}° (${Math.round((n.los - n.aos) / 60)} min)`;
  });
</script>

<div class="satmap">
  <div class="caption" data-k="satmap">
    <strong>{sat.short}</strong>
    {#if where.m}
      <span>over {where.m.now.lat.toFixed(1)}°, {where.m.now.lon.toFixed(1)}° · {Math.round(where.m.alt_km)} km up · heard within {Math.round(where.m.footprint_km)} km</span>
      <span class="sub" data-k="pass">{pass}</span>
    {:else}
      <span class="sub">{where.error}</span>
    {/if}
  </div>
  {#if mapError}<p class="sub">{mapError}</p>{/if}
  <div class="map" bind:this={el} aria-label={`${sat.short} on the map`}></div>
</div>

<style>
  .satmap {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .caption {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    align-items: baseline;
  }
  .map {
    height: 340px;
    border: 1px solid var(--line);
    border-radius: 8px;
  }
</style>
