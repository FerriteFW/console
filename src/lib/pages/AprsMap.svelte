<script lang="ts">
  // APRS › Map: the heard stations with a position, and the radio's own, on OpenStreetMap (Leaflet from a pinned CDN
  // version; the tiles attributed on the map). Live with the heard list's events. `?call=` centres a station,
  // `?at=lat,lon` a place (the Event Log's positions), `?wp=name` a waypoint. Otherwise it centres on you: the radio's
  // own position, or the browser's location when the radio has none (asked once; refused or unavailable falls back
  // to the stations). The radio's waypoints (GPS-10, as APRS › Waypoints holds them, unwritten edits too) are a layer
  // of their own, switched on and off here (remembered on this computer).
  import { aprs, ago, compass, distance } from "../aprs.svelte";
  import { degrees, SOURCE_WORDS, waypoints } from "../lists.svelte";
  import { radio } from "../radio.svelte";
  import { ATTRIBUTION, loadLeaflet, TILES, type Leaflet, type LLayer, type LMap, type LMarker } from "../leaflet";
  import { route } from "../route.svelte";

  let el: HTMLDivElement;
  let L = $state<Leaflet | null>(null);
  let map: LMap | null = null;
  let layers: LLayer[] = [];
  let mapError = $state("");
  let wpNote = $state("");
  let now = $state(Date.now());
  const connected = $derived(radio.phase === "connected");
  const WP_KEY = "ferrite.map.waypoints";
  let showWp = $state((() => {
    try {
      return localStorage.getItem(WP_KEY) !== "off";
    } catch {
      return true;
    }
  })());
  $effect(() => {
    try {
      localStorage.setItem(WP_KEY, showWp ? "on" : "off");
    } catch {
      /* storage blocked: on for this visit */
    }
  });
  $effect(() => {
    if (connected && waypoints.ready) waypoints.ensure();
  });
  const wps = $derived(showWp ? waypoints.items : []);
  const wpFocus = $derived(route.params.get("wp"));

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
        // Decision 396: a right-click adds a waypoint there, on top (unwritten until Write, as APRS › Waypoints)
        map.on("contextmenu", (e) => {
          if (!e.latlng || waypoints.items.length >= waypoints.max) return;
          (e.originalEvent as Event | undefined)?.preventDefault();
          const name = `Waypoint ${waypoints.items.length + 1}`;
          waypoints.add(name, [e.latlng.lat, e.latlng.lng]);
          showWp = true;
          wpNote = `Added ${name}: rename it in Waypoints, then Write.`;
        });
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
      layers.push(l.marker(at, { title: "From the Event Log" }).addTo(m).bindTooltip(`${at[0].toFixed(4)}, ${at[1].toFixed(4)}`));
    }
    // The waypoints: a diamond each, named; the one asked for (`?wp=`) opened.
    let wpAt: [number, number] | null = null;
    for (const w of wps) {
      const ll = degrees(w);
      pts.push(ll);
      const d = aprs.me ? distance(aprs.me, { lat: ll[0], lon: ll[1] }) : null;
      const mk = l
        .marker(ll, { icon: l.divIcon({ className: "aprs-wp", html: "<span></span>", iconSize: [14, 14] }), title: w.name, keyboard: false, draggable: true })
        .addTo(m)
        .bindTooltip(esc(w.name), { permanent: wps.length <= 25, direction: "right", className: "aprs-label wp-label" })
        .bindPopup(
          `<b>${esc(w.name)}</b> · waypoint<br>${ll[0].toFixed(5)}, ${ll[1].toFixed(5)}${d ? `<br>${d.km.toFixed(1)} km ${compass(d.deg)}` : ""}<br>${esc(SOURCE_WORDS[w.source] ?? w.source)}`,
        );
      // Decision 396: dragged, it moves (unwritten until Write)
      mk.on("dragend", () => {
        const p = (mk as unknown as LMarker).getLatLng();
        waypoints.edit(w.key, { lat: Math.round(p.lat * 1e7), lon: Math.round(p.lng * 1e7) });
        wpNote = `Moved ${w.name}: Write in Waypoints to put it on the radio.`;
      });
      if (wpFocus && w.name === wpFocus) {
        mk.openPopup();
        wpAt = ll;
      }
      layers.push(mk);
    }
    // Fit once per kind of view: the focus (a station, a place) or everything.
    const you: [number, number] | null = aprs.me ? [aprs.me.lat, aprs.me.lon] : here;
    const key = `${focus ?? ""}|${at?.join(",") ?? ""}|${wpAt?.join(",") ?? ""}|${you ? "you" : pts.length > 0}`;
    if (key !== fitted) {
      fitted = key;
      const f = focus ? placed.find((s) => s.call.toUpperCase() === focus) : null;
      if (wpAt) m.setView(wpAt, 13);
      else if (f) m.setView([f.lat!, f.lon!], 13);
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
    {#if waypoints.items.length || waypoints.base}
      <label class="wp-toggle" title="The radio's waypoints (APRS › Waypoints), as diamonds">
        <input type="checkbox" bind:checked={showWp} aria-label="Show waypoints" />
        <span class="wp-key" aria-hidden="true"></span> Waypoints ({waypoints.items.length})
      </label>
      <span class="sub" data-k="wp-note">{wpNote || "Right-click the map to add a waypoint; drag one to move it."}</span>
    {/if}
  </div>
  {#if mapError}<div class="pg-banner warn">{mapError}</div>{/if}
  {#if aprs.error}<div class="pg-banner">{aprs.error}</div>{/if}
  <div class="map" bind:this={el} data-map={L ? "ready" : "loading"} data-markers={placed.length + (aprs.me ? 1 : 0)} data-waypoints={wps.length} aria-label="Map of heard stations"></div>
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
  .map :global(.aprs-wp span),
  .wp-key {
    display: block;
    width: 10px;
    height: 10px;
    margin: 2px;
    transform: rotate(45deg);
    background: #f2b33d;
    border: 2px solid #8a5a00;
    box-sizing: border-box;
  }
  .wp-key {
    display: inline-block;
    margin: 0 2px 0 0;
    vertical-align: -1px;
  }
  .map :global(.wp-label) {
    color: #6b4500;
  }
  .wp-toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
    cursor: pointer;
  }
  .map :global(.leaflet-popup-content) {
    font: 12px/1.4 "JetBrains Mono", monospace;
  }
</style>
