<script lang="ts">
  // The "near me" map (Add channels › Near me, Map): the kinds shown (Repeaters, Business & public, Airports: the dialog's
  // sidebar; Canada and the US switched on: NearbyTab) near the place on one Leaflet map (bundled; OpenStreetMap tiles, attributed). It fills
  // the big dialog; Picked is a slim column on its right (below it on a narrow window). One marker per site (a name at a position) with its frequency count;
  // nearby markers cluster into a count until zoomed in (cluster.ts). A marker opens a small popup with a box per
  // frequency. Your pin is
  // the place; the circle is the search: drag its edge or use the slider and the results load again (debounced).
  // Sites outside the circle fade until they do. The Picked column lists the picks (shared with the lists:
  // nearby.svelte.ts) with the zone target and Add. With `ontune` (Live View's Tune from map) a popup's frequency is a
  // button that tunes the radio, and there is no Picked column.
  import { tick, untrack } from "svelte";
  import { canLocate, library } from "../../library.svelte";
  import { radio } from "../../radio.svelte";
  import { airportSites, repeaterSites, sites, sourceName } from "../../sites.svelte";
  import { MOBILE, mhz, modeLabel, nearby, offsetLabel, repeaterMode, toneLabel } from "../../nearby.svelte";
  import { toneWord, type Tune } from "../../tune";
  import { MODE_FM, MODE_NFM } from "../../sitedata";
  import { gridCluster } from "../../cluster";
  import { ATTRIBUTION, loadLeaflet, NO_TILES, TILES, type LatLng, type LCircle, type Leaflet, type LGroup, type LMap, type LMarker } from "../../leaflet";
  import DataCredits from "./DataCredits.svelte";
  import AddBar from "./AddBar.svelte";

  let { each = "", onadded = () => {}, ontune }: { each?: string; onadded?: () => void; ontune?: (t: Tune) => void } = $props();

  /** `tone`: a repeater's tones (`label` is then its offset). `tune`: what a click tunes (Tune from map). */
  type Row = { key: string; mhz: string; label: string; mobile: boolean; tone?: string; tune: Tune };
  type Site = { id: string; kind: "lic" | "air" | "rpt"; src: string; name: string; pos: LatLng; km: number; rows: Row[] };

  const on = (src: string) => nearby.layers[src] !== false;

  /** The markers' sites: licensees by name and position (a box picks the organization's frequency, shared by its
   * other sites), airports as they are; frequencies in order. */
  const mapSites = $derived.by((): Site[] => {
    const by = new Map<string, Site>();
    for (const e of nearby.showLic ? nearby.siteRows : []) {
      if (!on(e.src) || nearby.catsOff.has(e.k) || !nearby.matchSite(e)) continue;
      const id = `s|${e.name}|${e.pos[0]}|${e.pos[1]}`;
      let s = by.get(id);
      if (!s) by.set(id, (s = { id, kind: "lic", src: e.src, name: e.name, pos: e.pos, km: e.km, rows: [] }));
      const mode = e.m === MODE_NFM ? "NFM" : e.m === MODE_FM ? "FM" : nearby.mode;
      s.rows.push({ key: e.key, mhz: mhz(e.f), label: modeLabel(e.m), mobile: e.mobile, tune: { name: e.name, hz: e.f * 500, mode, kind: "lic", pos: e.pos } });
      s.km = Math.min(s.km, e.km);
    }
    const out = [...by.values()];
    for (const s of out) s.rows.sort((a, b) => Number(a.mhz) - Number(b.mhz));
    if (nearby.showAir) {
      for (const a of nearby.airports) {
        const freqs = a.freqs.filter((q) => nearby.matchAirport(a.c, q.type, q.khz));
        if (!freqs.length) continue;
        out.push({
          id: `a|${a.key}`,
          kind: "air",
          src: "airports",
          name: a.c,
          pos: a.l,
          km: a.km,
          rows: freqs.map((q) => ({ key: q.key, mhz: (q.khz / 1000).toFixed(3), label: q.type, mobile: false, tune: { name: `${a.c} ${q.type}`, hz: Math.round(q.khz * 1000), mode: "AM", kind: "air", pos: a.l } })),
        });
      }
    }
    if (nearby.showRpt) {
      for (const r of nearby.repeaters) {
        const freqs = r.freqs.filter((q) => nearby.matchRepeater(r.c, q.f));
        if (!freqs.length) continue;
        out.push({
          id: r.key,
          kind: "rpt",
          src: "repeaters",
          name: r.c,
          pos: r.l,
          km: r.km,
          rows: freqs.map((q) => ({
            key: q.key,
            mhz: mhz(q.f),
            label: offsetLabel(q.d),
            mobile: false,
            tone: toneLabel(q.te, q.td),
            tune: { name: r.c, hz: q.f * 500, mode: repeaterMode(q.m, r.l[1]), shiftHz: q.d * 500, txTone: q.te ? toneWord(q.te) : undefined, rxTone: q.td ? toneWord(q.td) : undefined, kind: "rpt", pos: r.l },
          })),
        });
      }
    }
    return out;
  });
  const shownSites = $derived(mapSites);
  const byId = $derived(new Map(shownSites.map((s) => [s.id, s])));
  const picked = (s: Site) => s.rows.some((r) => nearby.has(r.key));

  // The radius as the circle and slider show it: the library's, or the one being dragged or slid (the library takes
  // it a moment after the last change, and the results load again).
  let r = $state(library.radius);
  $effect(() => {
    const x = library.radius;
    untrack(() => (r = x));
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  function commit(now = false) {
    clearTimeout(timer);
    if (now) library.radius = r;
    else timer = setTimeout(() => (library.radius = r), 450);
  }
  $effect(() => () => clearTimeout(timer));
  const clampKm = (km: number) => Math.max(1, Math.min(400, Math.round(km)));

  // The map.
  let el: HTMLDivElement;
  let wrap: HTMLDivElement;
  let L = $state<Leaflet | null>(null);
  let map: LMap | null = null;
  let markers: LGroup | null = null;
  let pin: ReturnType<Leaflet["circleMarker"]> | null = null;
  let circle: LCircle | null = null;
  let handle: LMarker | null = null;
  let dragging = false;
  /** The place the circle is round (the handle's drag measures from it). */
  let centre: LatLng = [0, 0];
  let mapError = $state("");
  let stop = () => {};
  let zoom = $state(0);
  /** Bumped as the map moves: the popup follows its marker. */
  let moved = $state(0);
  /** The open popup: the sites it lists (one, or a cluster too close to split). */
  let open = $state<string[]>([]);

  $effect(() => {
    let gone = false;
    loadLeaflet()
      .then((l) => {
        if (gone) return;
        const m = l.map(el, { worldCopyJump: true, zoomSnap: 0.5 }).setView([50, -100], 3);
        if (!NO_TILES) l.tileLayer(TILES, { maxZoom: 18, attribution: ATTRIBUTION }).addTo(m);
        markers = l.layerGroup().addTo(m);
        m.on("zoomend", () => (zoom = m.getZoom()));
        m.on("move", () => moved++);
        m.on("click", (e) => {
          const t = e.originalEvent?.target as Element | undefined;
          if (!t?.closest?.(".leaflet-marker-icon")) open = [];
        });
        zoom = m.getZoom();
        // The dialog's layout settles after the map is made (the big dialog, windows resizing): Leaflet measures
        // again, so the tiles fill it.
        const ro = new ResizeObserver(() => m.invalidateSize());
        ro.observe(el);
        const raf = requestAnimationFrame(() => m.invalidateSize());
        stop = () => (ro.disconnect(), cancelAnimationFrame(raf));
        map = m;
        L = l;
      })
      .catch((e) => (mapError = (e as Error).message));
    return () => {
      gone = true;
      stop();
      map?.remove();
      map = null;
      markers = pin = circle = handle = null;
    };
  });

  /** The point `km` east of a place (the circle's edge handle). */
  const east = (p: LatLng, km: number): LatLng => [p[0], p[1] + km / (111.32 * Math.cos((p[0] * Math.PI) / 180))];

  // Your pin and the circle: made or moved with the place, sized with the radius; the view fits a new place, or a
  // committed radius the view doesn't hold.
  let fittedFor = "";
  $effect(() => {
    const l = L;
    const m = map;
    const p = library.place;
    const km = r;
    const committed = library.radius;
    if (!l || !m) return;
    if (!p) {
      for (const x of [pin, circle, handle]) x?.remove();
      pin = circle = handle = null;
      fittedFor = "";
      return;
    }
    const c: LatLng = [p.lat, p.lon];
    centre = c;
    if (!circle) {
      circle = l.circle(c, { radius: km * 1000, weight: 1.5, dashArray: "5 4", fillOpacity: 0.05, interactive: false, className: "nm-circle" }).addTo(m) as LCircle;
      pin = l.circleMarker(c, { radius: 8, weight: 3, fillOpacity: 1, interactive: false, className: "nm-you" }).addTo(m);
      handle = l
        .marker(east(c, km), { draggable: true, keyboard: false, title: "Drag to change the radius", icon: l.divIcon({ className: "nm-handle", iconSize: [14, 14], iconAnchor: [7, 7] }) })
        .addTo(m) as LMarker;
      handle.on("dragstart", () => (dragging = true));
      handle.on("drag", () => {
        const at = handle!.getLatLng();
        r = clampKm(m.distance(centre, at) / 1000);
        commit();
      });
      handle.on("dragend", () => {
        dragging = false;
        handle!.setLatLng(east(centre, r));
        commit(true);
      });
    } else {
      circle.setLatLng(c);
      (pin as unknown as LCircle).setLatLng(c);
    }
    circle.setRadius(km * 1000);
    if (!dragging) handle?.setLatLng(east(c, km));
    const key = `${p.lat},${p.lon}`;
    if (key !== fittedFor) {
      fittedFor = key;
      m.fitBounds(circle.getBounds(), { padding: [16, 16], animate: false });
    } else if (km === committed && !dragging && !m.getBounds().contains(circle.getBounds())) {
      m.fitBounds(circle.getBounds(), { padding: [16, 16] });
    }
  });

  // The locate button: the place from the radio (else this computer), then the view on it, even when the place
  // didn't change and the map was only panned away.
  let locating = $state(false);
  const canFind = $derived(radio.phase === "connected" || canLocate);
  async function locate() {
    if (locating) return;
    locating = true;
    try {
      await library.locate();
      await tick();
      if (map && circle) map.fitBounds(circle.getBounds(), { padding: [16, 16] });
    } finally {
      locating = false;
    }
  }

  const CELL = 44;

  // The markers: again when the sites, picks, radius or zoom change. Clusters below the zoom where they split.
  $effect(() => {
    const l = L;
    const m = map;
    const g = markers;
    const list = shownSites;
    const km = r;
    const z = zoom;
    void nearby.picks;
    if (!l || !m || !g) return;
    g.clearLayers();
    const groups = gridCluster(list, (s) => m.project(s.pos, z), CELL);
    for (const grp of groups) {
      if (grp.length === 1) {
        const s = grp[0];
        const kind = picked(s) ? "pick" : s.kind;
        const n = s.rows.length;
        const mk = l.marker(s.pos, {
          icon: l.divIcon({ className: "nm-icon", html: `<span class="nm-pin ${kind}${s.km > km ? " out" : ""}">${n > 1 ? n : ""}</span>`, iconSize: [24, 24], iconAnchor: [12, 12] }),
          title: s.name,
          riseOnHover: true,
        });
        mk.on("click", () => (open = open.length === 1 && open[0] === s.id ? [] : [s.id]));
        mk.addTo(g);
        label(mk, `${s.name}: ${n} ${n === 1 ? "frequency" : "frequencies"}`);
      } else {
        const anyPicked = grp.some(picked);
        const allOut = grp.every((s) => s.km > km);
        const pts = grp.map((s) => s.pos);
        const mk = l.marker(pts[0], {
          icon: l.divIcon({ className: "nm-icon", html: `<span class="nm-cluster${anyPicked ? " pick" : ""}${allOut ? " out" : ""}">${grp.length}</span>`, iconSize: [32, 32], iconAnchor: [16, 16] }),
          title: `${grp.length} sites`,
        });
        // Too close to split by zooming (a tower, an airport's field): the popup lists them all.
        const spread = Math.max(...pts.map((p) => m.distance(pts[0], p)));
        mk.on("click", () => {
          if (z >= 16 || spread < 300) open = grp.map((s) => s.id);
          else m.fitBounds(pts, { padding: [60, 60], maxZoom: 17 });
        });
        mk.addTo(g);
        label(mk, `${grp.length} sites: ${grp.map((s) => s.name).join(", ")}`);
      }
    }
  });
  function label(mk: LMarker, text: string) {
    const e = mk.getElement?.();
    if (!e) return;
    e.setAttribute("role", "button");
    e.setAttribute("aria-label", text);
  }

  // The popup: beside its (first) site, kept inside the map.
  const popSites = $derived(open.map((id) => byId.get(id)).filter((s): s is Site => !!s));
  let popEl = $state<HTMLDivElement | null>(null);
  const popAt = $derived.by(() => {
    void moved;
    void zoom;
    const m = map;
    const s = popSites[0];
    if (!m || !s || !wrap) return null;
    const p = m.latLngToContainerPoint(s.pos);
    const w = popEl?.offsetWidth ?? 260;
    const h = popEl?.offsetHeight ?? 200;
    const left = p.x + 16 + w > wrap.clientWidth ? p.x - 16 - w : p.x + 16;
    return { left: Math.max(6, left), top: Math.max(6, Math.min(p.y - 24, wrap.clientHeight - h - 6)) };
  });

  // The Picked column.
  type Pick = { key: string; name: string; mhz: string; tag: string };
  const picks = $derived.by((): Pick[] => [
    ...nearby.pickedSites.map((e) => ({ key: e.key, name: e.name, mhz: mhz(e.f), tag: modeLabel(e.m) })),
    ...nearby.pickedAirports.flatMap(({ a, freqs }) => freqs.map((q) => ({ key: q.key, name: a.c, mhz: (q.khz / 1000).toFixed(3), tag: q.type }))),
    ...nearby.pickedRepeaters.flatMap(({ r, freqs }) => freqs.map((q) => ({ key: q.key, name: r.c, mhz: mhz(q.f), tag: offsetLabel(q.d) }))),
  ]);

  // What the status line says.
  const siteFailed = $derived(nearby.siteResult?.failed ?? []);
  const airFailed = $derived(nearby.airportResult?.failed ?? []);
  const sitesDown = $derived(nearby.showLic && !!nearby.siteResult && !nearby.siteResult.sources.length && siteFailed.length > 0 && siteFailed.length >= sites.sources.length);
  const airDown = $derived(nearby.showAir && !!nearby.airportResult && !nearby.airportResult.sources.length && airFailed.length > 0);
  const rptFailed = $derived(nearby.repeaterResult?.failed ?? []);
  const rptDown = $derived(nearby.showRpt && !!nearby.repeaterResult && !nearby.repeaterResult.sources.length && rptFailed.length > 0);
  const loading = $derived(
    !!library.place && ((nearby.showLic && !nearby.siteResult) || (nearby.showAir && !nearby.airportResult) || (nearby.showRpt && !nearby.repeaterResult)),
  );
  const siteHere = $derived(new Set(nearby.siteAll.map((e) => e.src)));
  const airHere = $derived(new Set(nearby.airports.length ? ["airports"] : []));
  const rptHere = $derived(new Set(nearby.repeaters.length ? ["repeaters"] : []));
</script>

<div class="nm" class:tuning={!!ontune}>
  <div class="mapcol">
    <div class="status" role="status">
      <label class="radius">
        Radius
        <input type="range" min="5" max="400" step="5" value={r} oninput={(e) => ((r = Number(e.currentTarget.value)), commit())} aria-label="Radius in km" />
        <span class="km">{r} km</span>
      </label>
      <input class="find" type="search" placeholder="Search: name, category, airport, callsign or MHz" bind:value={nearby.query} aria-label="Search sites near the place" />
      {#if !library.place}
        Give a place above: type one, take the radio's, or use your location.
      {:else if loading}
        Loading what's near the place…
      {:else}
        {shownSites.length} {shownSites.length === 1 ? "site" : "sites"} on the map within {library.radius} km{nearby.query.trim() ? " matching the search" : ""}.{#if nearby.showLic && nearby.siteCapped}&nbsp;Only the nearest licensed sites show: make the circle smaller to see them all.{/if}
      {/if}
      {#if sitesDown}<span class="bad"><b>Business and public sites aren't available right now.</b> {siteFailed[0].error}. <button class="link" onclick={() => sites.retry()}>Try again</button></span>{/if}
      {#if airDown}<span class="bad"><b>Airports aren't available right now.</b> {airFailed[0].error}. <button class="link" onclick={() => airportSites.retry()}>Try again</button></span>{/if}
      {#if rptDown}<span class="bad"><b>Repeaters aren't available right now.</b> {rptFailed[0].error}. <button class="link" onclick={() => repeaterSites.retry()}>Try again</button></span>{/if}
      {#if nearby.showLic && !sitesDown && siteFailed.length}<span class="bad">{siteFailed.map((f) => `${sourceName(f.src, sites.source(f.src)?.title)}: ${f.error}`).join(" · ")}</span>{/if}
    </div>
    <div class="wrap" bind:this={wrap}>
      <div class="map" bind:this={el} data-map={L ? "ready" : "loading"} data-sites={shownSites.length} aria-label="Map of sites near the place"></div>
      {#if L}
        <button
          class="locate"
          disabled={locating || (!canFind && !library.place)}
          onclick={locate}
          title={radio.phase === "connected" ? "Centre on me: the radio's GPS fix, else its fixed position" : canLocate ? "Centre on me: this computer's location" : library.place ? "Centre on the place" : "Connect a radio to centre on its position"}
          aria-label="Centre the map on my position"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="6.5" fill="none" stroke="currentColor" stroke-width="2" /><circle cx="12" cy="12" r="2.5" fill="currentColor" /><path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
        </button>
      {/if}
      {#if mapError}<div class="over">{mapError}</div>{/if}
      {#if NO_TILES}<div class="notiles">No map background when Console is opened from a file (OpenStreetMap's tile policy). The markers still work; for the full map use <a href="https://console.ferritefw.dev" target="_blank" rel="noreferrer">console.ferritefw.dev</a> or the desktop app.</div>{/if}
      <div class="legend" aria-hidden="true">
        <span><i class="dot you"></i>The place</span>
        {#if nearby.showLic}<span><i class="dot lic"></i>Business &amp; public</span>{/if}
        {#if nearby.showAir}<span><i class="dot air"></i>Airport</span>{/if}
        {#if nearby.showRpt}<span><i class="dot rpt"></i>Repeater</span>{/if}
        {#if !ontune}<span><i class="dot pick"></i>Picked</span>{/if}
      </div>
      {#if popSites.length && popAt}
        <div class="pop" bind:this={popEl} style:left="{popAt.left}px" style:top="{popAt.top}px" role="dialog" aria-label="Frequencies at {popSites[0].name}">
          <button class="x" onclick={() => (open = [])} aria-label="Close">✕</button>
          {#each popSites as s (s.id)}
            {@const all = s.rows.every((q) => nearby.has(q.key))}
            <section>
              <header>
                <b>{s.name}</b>
                <span>
                  {s.kind === "air" ? "Airport" : s.kind === "rpt" ? "Repeater" : `Business & public · ${sourceName(s.src)}`} · {s.km < 10 ? s.km.toFixed(1) : Math.round(s.km)} km
                  {#if s.rows.length > 1 && !ontune}· <button class="link" onclick={() => nearby.set(s.rows.map((q) => q.key), !all)}>{all ? "None" : "All"}</button>{/if}
                </span>
              </header>
              <ul>
                {#each s.rows as q (q.key)}
                  <li>
                    {#if ontune}
                      <button class="tune" onclick={() => ontune(q.tune)} aria-label="Tune {s.name} {q.mhz} {q.label}" title="Tune the radio's active slot to {q.mhz} MHz (VFO; no channel saved)">
                        <span class="mono">{q.mhz}</span>
                        <span class="tag">{q.label}</span>
                        {#if q.tone}<span class="tag">{q.tone}</span>{/if}
                        {#if q.mobile}<span class="tag mob" title={MOBILE}>mobile</span>{/if}
                      </button>
                    {:else}
                      <label>
                        <input type="checkbox" checked={nearby.has(q.key)} onchange={() => nearby.toggle(q.key)} aria-label="{s.name} {q.mhz} {q.label}" />
                        <span class="mono">{q.mhz}</span>
                        <span class="tag">{q.label}</span>
                        {#if q.tone}<span class="tag">{q.tone}</span>{/if}
                        {#if q.mobile}<span class="tag mob" title={MOBILE}>mobile</span>{/if}
                      </label>
                    {/if}
                  </li>
                {/each}
              </ul>
            </section>
          {/each}
        </div>
      {/if}
    </div>
  </div>
  {#if !ontune}
  <aside class="side" aria-label="Picked">
    <h3>Picked <span class="count">{picks.length + nearby.nCommon}</span>{#if picks.length}<button class="link clear" onclick={() => nearby.clear()}>Clear</button>{/if}</h3>
    <ul class="picked">
      {#each picks as p (p.key)}
        <li>
          <span class="n">{p.name}</span><span class="mono">{p.mhz}</span><span class="tag">{p.tag}</span>
          <button class="rm" onclick={() => nearby.toggle(p.key)} aria-label="Remove {p.name} {p.mhz}">✕</button>
        </li>
      {/each}
      {#if nearby.nCommon}
        <li><span class="n">Airband (common)</span><span class="mono">{nearby.nCommon}</span><span class="tag">AM</span><button class="rm" onclick={() => (nearby.common = false)} aria-label="Remove the common airband frequencies">✕</button></li>
      {/if}
      {#if !picks.length && !nearby.nCommon}
        <li class="empty">Click a marker, then tick its frequencies.</li>
      {/if}
    </ul>
    <AddBar side {each} {onadded} />
  </aside>
  {/if}
</div>
<div class="feet">
  <DataCredits
    shown={[
      ...(nearby.showRpt ? [{ data: repeaterSites, here: rptHere }] : []),
      ...(nearby.showLic ? [{ data: sites, here: siteHere }] : []),
      ...(nearby.showAir ? [{ data: airportSites, here: airHere }] : []),
    ]}
  />
</div>

<style>
  .nm {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 260px;
    gap: 12px;
  }
  .mapcol {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    min-height: 0;
  }
  .dot {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--map-lic);
  }
  .dot.air {
    background: var(--map-air);
  }
  .dot.rpt {
    background: var(--map-rpt);
  }
  .dot.pick {
    background: var(--map-pick);
  }
  .dot.you {
    background: var(--blue);
  }
  .radius {
    display: inline-flex;
    gap: 8px;
    align-items: center;
    color: var(--sub);
  }
  .radius input {
    width: 160px;
    accent-color: var(--blue);
  }
  .km {
    min-width: 52px;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .find {
    width: 260px;
    max-width: 100%;
    font: inherit;
    font-size: 13px;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 7px;
    padding: 4px 8px;
  }
  .status {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 12px;
    font-size: 12px;
    color: var(--sub);
  }
  .bad {
    color: var(--red);
  }
  .wrap {
    position: relative;
    flex: 1;
    min-height: 260px;
    border: 1px solid var(--line);
    border-radius: 8px;
    overflow: hidden;
  }
  .map {
    position: absolute;
    inset: 0;
    isolation: isolate;
    background: var(--surface);
  }
  .locate {
    position: absolute;
    top: 82px;
    left: 10px;
    z-index: 1;
    width: 34px;
    height: 34px;
    display: grid;
    place-items: center;
    padding: 0;
    background: var(--surface);
    color: var(--text);
    border: 2px solid rgba(0, 0, 0, 0.2);
    border-radius: 4px;
    background-clip: padding-box;
    cursor: pointer;
  }
  .locate:hover:not(:disabled) {
    color: var(--blue);
  }
  .locate:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .over {
    position: absolute;
    inset: 40% 10% auto;
    text-align: center;
    color: var(--red);
    z-index: 1;
  }
  .legend {
    position: absolute;
    left: 8px;
    bottom: 8px;
    z-index: 1;
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 7px;
    padding: 3px 8px;
    font-size: 11px;
    color: var(--sub);
  }
  .legend .dot {
    width: 9px;
    height: 9px;
    margin-right: 4px;
    vertical-align: -1px;
  }
  .pop {
    position: absolute;
    z-index: 2;
    width: 260px;
    max-height: calc(100% - 12px);
    overflow: auto;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 9px;
    box-shadow: var(--shadow);
    font-size: 13px;
  }
  .pop section + section {
    border-top: 1px solid var(--line);
  }
  .pop header {
    padding: 8px 28px 6px 10px;
    border-bottom: 1px solid var(--line);
  }
  .pop header b {
    display: block;
    overflow-wrap: anywhere;
  }
  .pop header span {
    color: var(--sub);
    font-size: 12px;
  }
  .pop ul,
  .picked {
    list-style: none;
    margin: 0;
    padding: 4px;
  }
  .pop label {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 2px 6px;
    border-radius: 5px;
    cursor: pointer;
  }
  .pop label:hover,
  .pop .tune:hover {
    background: var(--raised);
  }
  /* Tune from map: a frequency is one click. */
  .pop .tune {
    display: flex;
    gap: 8px;
    align-items: center;
    width: 100%;
    font: inherit;
    color: inherit;
    text-align: left;
    background: none;
    border: none;
    padding: 4px 6px;
    border-radius: 5px;
    cursor: pointer;
  }
  .pop .tune .mono {
    color: var(--blue);
  }
  .nm.tuning {
    grid-template-columns: minmax(0, 1fr);
  }
  .x {
    position: absolute;
    top: 4px;
    right: 4px;
    background: none;
    border: none;
    color: var(--sub);
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 5px;
  }
  .x:hover {
    color: var(--text);
    background: var(--raised);
  }
  .mono {
    font-variant-numeric: tabular-nums;
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 12px;
  }
  .tag {
    font-size: 11px;
    color: var(--sub);
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 0 4px;
  }
  .tag.mob {
    border-style: dashed;
  }
  .link {
    font: inherit;
    background: none;
    border: none;
    padding: 0;
    color: var(--blue);
    cursor: pointer;
  }
  .side {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
    min-width: 0;
  }
  .side h3 {
    margin: 0;
    font-size: 12px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--sub);
    display: flex;
    gap: 8px;
    align-items: baseline;
  }
  .count {
    color: var(--text);
  }
  .clear {
    margin-left: auto;
    text-transform: none;
    letter-spacing: 0;
    font-size: 12px;
  }
  .picked {
    flex: 1;
    min-height: 60px;
    overflow: auto;
    border: 1px solid var(--line);
    border-radius: 8px;
    font-size: 13px;
  }
  .picked li {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 3px 6px;
    border-radius: 5px;
  }
  .picked li:hover {
    background: var(--raised);
  }
  .picked .n {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .picked .empty {
    color: var(--sub);
    font-size: 12px;
    padding: 8px;
  }
  .rm {
    background: none;
    border: none;
    color: var(--sub);
    cursor: pointer;
    padding: 0 4px;
  }
  .rm:hover {
    color: var(--red);
  }
  .feet {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  /* The markers (Leaflet's divIcons, outside this component's DOM). */
  .map :global(.nm-icon) {
    background: none;
    border: none;
  }
  .map :global(.nm-pin),
  .map :global(.nm-cluster) {
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
    border-radius: 50%;
    border: 2px solid #fff;
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.35);
    color: #fff;
    font: 700 11px system-ui, sans-serif;
    box-sizing: border-box;
  }
  .map :global(.nm-pin.lic) {
    background: var(--map-lic);
  }
  .map :global(.nm-pin.air) {
    background: var(--map-air);
  }
  .map :global(.nm-pin.rpt) {
    background: var(--map-rpt);
  }
  .map :global(.nm-pin.pick) {
    background: var(--map-pick);
    transform: scale(1.15);
  }
  .map :global(.nm-cluster) {
    background: var(--surface);
    color: var(--text);
    border: 3px solid var(--map-lic);
    font-size: 12px;
  }
  .map :global(.nm-cluster.pick) {
    border-color: var(--map-pick);
  }
  .map :global(.out) {
    opacity: 0.35;
  }
  /* The circle and your pin (SVG paths: CSS wins over Leaflet's colour attributes). */
  .map :global(.nm-circle) {
    stroke: var(--blue);
    fill: var(--blue);
  }
  .map :global(.nm-you) {
    stroke: #fff;
    fill: var(--blue);
  }
  .map :global(.nm-handle) {
    background: var(--surface);
    border: 2px solid var(--blue);
    border-radius: 50%;
    cursor: ew-resize;
    box-sizing: border-box;
  }
  @media (max-width: 900px) {
    .nm {
      display: flex;
      flex-direction: column;
      overflow: auto;
    }
    .mapcol,
    .side {
      flex: none;
    }
    .wrap {
      flex: none;
      height: 300px;
    }
    .picked {
      flex: none;
      max-height: 160px;
    }
    .radius input {
      width: 110px;
    }
  }
  .notiles {
    position: absolute;
    left: 50%;
    top: 10px;
    transform: translateX(-50%);
    z-index: 500;
    max-width: min(520px, 90%);
    padding: 6px 10px;
    border-radius: 7px;
    background: var(--surface);
    border: 1px solid var(--line);
    font-size: 12px;
    color: var(--sub);
    text-align: center;
  }
</style>
