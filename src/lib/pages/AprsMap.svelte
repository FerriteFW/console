<script lang="ts">
  // APRS › Map: the heard stations with a position, and the radio's own, on OpenStreetMap (Leaflet from a pinned CDN
  // version; the tiles attributed on the map). Live with the heard list's events. `?call=` centres a station,
  // `?at=lat,lon` a place (the Activity Log's positions). Otherwise it centres on you: the radio's own position, or
  // the browser's location when the radio has none (asked once; refused or unavailable falls back to the stations).
  import { aprs, ago, compass, distance } from "../aprs.svelte";
  import { radio } from "../radio.svelte";
  import { ATTRIBUTION, loadLeaflet, TILES, type Leaflet, type LLayer, type LMap } from "../leaflet";
  import { route } from "../route.svelte";

  let el: HTMLDivElement;
  let L = $state<Leaflet | null>(null);
  let map: LMap | null = null;
  let layers: LLayer[] = [];
  let mapError = $state("");
  let now = $state(Date.now());
  const connected = $derived(radio.phase === "connected");

  $effect(() => aprs.use());
  $effect(() => {
    if (connected) aprs.ensure();
  });
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 15_000);
    return () => clearInterval(t);
  });

  $effect(() => {
    let gone = false;
    loadLeaflet()
      .then((l) => {
        if (gone) return;
        map = l.map(el, { worldCopyJump: true }).setView([45.42, -75.69], 9);
        l.tileLayer(TILES, { maxZoom: 18, attribution: ATTRIBUTION }).addTo(map);
        L = l;
      })
      .catch((e) => (mapError = (e as Error).message));
    return () => {
      gone = true;
      map?.remove();
      map = null;
    };
  });

  const placed = $derived(aprs.stations.filter((s) => s.lat !== null && s.lon !== null));
  const at = $derived.by(() => {
    const a = route.params.get("at")?.split(",").map(Number);
    return a && a.length === 2 && a.every(Number.isFinite) ? ([a[0], a[1]] as [number, number]) : null;
  });
  const focus = $derived(route.params.get("call")?.toUpperCase() ?? null);
  let here = $state<[number, number] | null>(null);
  $effect(() => {
    if (aprs.me || here || typeof navigator === "undefined" || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (p) => (here = [p.coords.latitude, p.coords.longitude]),
      () => {},
      { timeout: 10_000, maximumAge: 600_000 },
    );
  });
  let fitted = "";

  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

  // The markers again whenever the stations, the radio's place or the focus change.
  $effect(() => {
    const l = L;
    const m = map;
    if (!l || !m) return;
    for (const x of layers) x.remove();
    layers = [];
    const pts: [number, number][] = [];
    for (const s of placed) {
      const ll: [number, number] = [s.lat!, s.lon!];
      pts.push(ll);
      const d = aprs.me ? distance(aprs.me, { lat: s.lat!, lon: s.lon! }) : null;
      const mk = l
        .circleMarker(ll, { radius: s.call.toUpperCase() === focus ? 9 : 6, color: "#0057c2", weight: 2, fillColor: "#4da3ff", fillOpacity: 0.85, className: "aprs-station" })
        .addTo(m)
        .bindTooltip(esc(s.call), { permanent: placed.length <= 25, direction: "right", className: "aprs-label" })
        .bindPopup(
          `<b>${esc(s.call)}</b> · ${esc(s.symbol_name)}<br>${esc(ago(s.at, now))}, heard ${s.times}×${d ? `<br>${d.km.toFixed(1)} km ${compass(d.deg)}` : ""}<br>${esc(s.path || "direct")}${s.comment ? `<br>${esc(s.comment)}` : ""}`,
        );
      if (s.call.toUpperCase() === focus) mk.openPopup();
      layers.push(mk);
    }
    if (aprs.me) {
      const ll: [number, number] = [aprs.me.lat, aprs.me.lon];
      pts.push(ll);
      layers.push(
        l
          .circleMarker(ll, { radius: 8, color: "#7a2", weight: 3, fillColor: "#7ce38b", fillOpacity: 0.9, className: "aprs-me" })
          .addTo(m)
          .bindTooltip(`This radio (${esc(aprs.me.from)})`, { direction: "right" }),
      );
    }
    if (!aprs.me && here) {
      layers.push(
        l
          .circleMarker(here, { radius: 7, color: "#7a2", weight: 2, fillColor: "#7ce38b", fillOpacity: 0.5, className: "aprs-here" })
          .addTo(m)
          .bindTooltip("You (this computer's location)", { direction: "right" }),
      );
    }
    if (at) {
      layers.push(l.marker(at, { title: "From the Activity Log" }).addTo(m).bindTooltip(`${at[0].toFixed(4)}, ${at[1].toFixed(4)}`));
    }
    // Fit once per kind of view: the focus (a station, a place) or everything.
    const you: [number, number] | null = aprs.me ? [aprs.me.lat, aprs.me.lon] : here;
    const key = `${focus ?? ""}|${at?.join(",") ?? ""}|${you ? "you" : pts.length > 0}`;
    if (key !== fitted) {
      fitted = key;
      const f = focus ? placed.find((s) => s.call.toUpperCase() === focus) : null;
      if (f) m.setView([f.lat!, f.lon!], 13);
      else if (at) m.setView(at, 13);
      else if (you) m.setView(you, 11);
      else if (pts.length > 1) m.fitBounds(pts, { padding: [30, 30], maxZoom: 13 });
      else if (pts.length === 1) m.setView(pts[0], 12);
    }
  });
</script>

<div class="pg">
  <div class="pg-status" aria-live="polite" data-status>
    {#if aprs.busy}
      <span>{aprs.busy}…</span>
    {:else if aprs.loaded}
      <span>{placed.length} of {aprs.stations.length} heard stations have a position{radio.subMask & 1 ? " · live" : ""}.</span>
      {#if aprs.me}<span>Green: this radio ({aprs.me.from}).</span>{/if}
    {:else if !connected}
      <span>Connect to put the stations the radio heard on the map.</span>
    {/if}
  </div>
  {#if mapError}<div class="pg-banner warn">{mapError}</div>{/if}
  {#if aprs.error}<div class="pg-banner">{aprs.error}</div>{/if}
  <div class="map" bind:this={el} data-map={L ? "ready" : "loading"} data-markers={placed.length + (aprs.me ? 1 : 0)} aria-label="Map of heard stations"></div>
</div>

<style>
  .map {
    height: calc(100vh - 170px);
    min-height: 360px;
    border: 1px solid var(--line);
    border-radius: 10px;
    overflow: hidden;
    background: var(--surface);
  }
  .map :global(.aprs-label) {
    font: 600 11px "JetBrains Mono", monospace;
    padding: 1px 4px;
  }
  .map :global(.leaflet-popup-content) {
    font: 12px/1.4 "JetBrains Mono", monospace;
  }
</style>
