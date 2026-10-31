<script lang="ts">
  // The "near me" map (Add channels › Near me, Map): the kinds shown (Licensed, Airports or Both; Canada and the US
  // switched on: NearbyTab) near the place on one Leaflet map (bundled; OpenStreetMap tiles, attributed). It fills
  // the big dialog; Picked is a slim column on its right (below it on a narrow window). One marker per site (a name at a position) with its frequency count;
  // nearby markers cluster into a count until zoomed in (cluster.ts). A marker opens a small popup with a box per
  // frequency. Digital-only sites hide unless asked for. Your pin is
  // the place; the circle is the search: drag its edge or use the slider and the results load again (debounced).
  // Sites outside the circle fade until they do. The Picked column lists the picks (shared with the lists:
  // nearby.svelte.ts) with the zone target and Add.
  import { untrack } from "svelte";
  import { library } from "../../library.svelte";
  import { airportSites, sites, sourceName } from "../../sites.svelte";
  import { MODE_DIGITAL } from "../../sitedata";
  import { MOBILE, mhz, modeLabel, nearby } from "../../nearby.svelte";
  import { gridCluster } from "../../cluster";
  import { ATTRIBUTION, loadLeaflet, TILES, type LatLng, type LCircle, type Leaflet, type LGroup, type LMap, type LMarker } from "../../leaflet";
  import DataFooter from "./DataFooter.svelte";
  import AddBar from "./AddBar.svelte";

  let { each, onadded }: { each: string; onadded: () => void } = $props();

  type Row = { key: string; mhz: string; label: string; mobile: boolean; digital: boolean };
  type Site = { id: string; kind: "lic" | "air"; src: string; name: string; pos: LatLng; km: number; rows: Row[] };

  const on = (src: string) => nearby.layers[src] !== false;

  /** The markers' sites: licensed entries by name and position, airports as they are; frequencies in order. */
  const mapSites = $derived.by((): Site[] => {
    const by = new Map<string, Site>();
    for (const e of nearby.showLic ? nearby.siteAll : []) {
      if (!on(e.src)) continue;
      const id = `s|${e.name}|${e.pos[0]}|${e.pos[1]}`;
      let s = by.get(id);
      if (!s) by.set(id, (s = { id, kind: "lic", src: e.src, name: e.name, pos: e.pos, km: e.km, rows: [] }));
      s.rows.push({ key: e.key, mhz: mhz(e.f), label: modeLabel(e.m), mobile: e.mobile, digital: e.m === MODE_DIGITAL });
      s.km = Math.min(s.km, e.km);
    }
    const out = [...by.values()];
    for (const s of out) s.rows.sort((a, b) => Number(a.mhz) - Number(b.mhz));
    if (nearby.showAir) {
      for (const a of nearby.airports) {
        out.push({
          id: `a|${a.key}`,
          kind: "air",
          src: "airports",
          name: a.c,
          pos: a.l,
          km: a.km,
          rows: a.freqs.map((q) => ({ key: q.key, mhz: (q.khz / 1000).toFixed(3), label: q.type, mobile: false, digital: false })),
        });
      }
    }
    return out;
  });
  const digitalOnly = (s: Site) => s.rows.every((r) => r.digital);
  /** What the map shows: digital-only sites hidden unless asked for. */
  const shownSites = $derived(nearby.digital ? mapSites : mapSites.filter((s) => !digitalOnly(s)));
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
        l.tileLayer(TILES, { maxZoom: 18, attribution: ATTRIBUTION }).addTo(m);
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
        const kind = picked(s) ? "pick" : s.kind === "air" ? "air" : digitalOnly(s) ? "dig" : "lic";
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
  ]);

  // What the status line says.
  const siteFailed = $derived(nearby.siteResult?.failed ?? []);
  const airFailed = $derived(nearby.airportResult?.failed ?? []);
  const sitesDown = $derived(nearby.showLic && !!nearby.siteResult && !nearby.siteResult.sources.length && siteFailed.length > 0 && siteFailed.length >= sites.sources.length);
  const airDown = $derived(nearby.showAir && !!nearby.airportResult && !nearby.airportResult.sources.length && airFailed.length > 0);
  const loading = $derived(!!library.place && ((nearby.showLic && !nearby.siteResult) || (nearby.showAir && !nearby.airportResult)));
  const siteHere = $derived(new Set(nearby.siteEntries.map((e) => e.src)));
  const airHere = $derived(new Set(nearby.airports.length ? ["airports"] : []));
  const nHiddenDigital = $derived(mapSites.filter(digitalOnly).length);
</script>

<div class="nm">
  <div class="mapcol">
    <div class="status" role="status">
      <label class="radius">
        Radius
        <input type="range" min="5" max="400" step="5" value={r} oninput={(e) => ((r = Number(e.currentTarget.value)), commit())} aria-label="Radius in km" />
        <span class="km">{r} km</span>
      </label>
      {#if !library.place}
        Give a place above: type one, take the radio's, or use your location.
      {:else if loading}
        Loading what's near the place…
      {:else}
        {shownSites.length} {shownSites.length === 1 ? "site" : "sites"} on the map within {library.radius} km.
      {/if}
      {#if nearby.showLic && nearby.nDigital}
        <label class="dig"><input type="checkbox" bind:checked={nearby.digital} /> Show digital only ({nHiddenDigital})</label>
      {/if}
      {#if sitesDown}<span class="bad"><b>Licensed sites aren't available right now.</b> {siteFailed[0].error}. <button class="link" onclick={() => sites.retry()}>Try again</button></span>{/if}
      {#if airDown}<span class="bad"><b>Airports aren't available right now.</b> {airFailed[0].error}. <button class="link" onclick={() => airportSites.retry()}>Try again</button></span>{/if}
      {#if nearby.showLic && !sitesDown && siteFailed.length}<span class="bad">{siteFailed.map((f) => `${sourceName(f.src, sites.source(f.src)?.title)}: ${f.error}`).join(" · ")}</span>{/if}
    </div>
    <div class="wrap" bind:this={wrap}>
      <div class="map" bind:this={el} data-map={L ? "ready" : "loading"} data-sites={shownSites.length} aria-label="Map of sites near the place"></div>
      {#if mapError}<div class="over">{mapError}</div>{/if}
      <div class="legend" aria-hidden="true">
        <span><i class="dot you"></i>The place</span>
        {#if nearby.showLic}<span><i class="dot lic"></i>Licensed</span>{/if}
        {#if nearby.showAir}<span><i class="dot air"></i>Airport</span>{/if}
        {#if nearby.showLic && nearby.digital}<span><i class="dot dig"></i>Digital only</span>{/if}<span><i class="dot pick"></i>Picked</span>
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
                  {s.kind === "air" ? "Airport" : `Licensed site · ${sourceName(s.src)}`}{digitalOnly(s) ? " · digital only" : ""} · {s.km < 10 ? s.km.toFixed(1) : Math.round(s.km)} km
                  {#if s.rows.length > 1}· <button class="link" onclick={() => nearby.set(s.rows.map((q) => q.key), !all)}>{all ? "None" : "All"}</button>{/if}
                </span>
              </header>
              <ul>
                {#each s.rows as q (q.key)}
                  <li>
                    <label>
                      <input type="checkbox" checked={nearby.has(q.key)} onchange={() => nearby.toggle(q.key)} aria-label="{s.name} {q.mhz} {q.label}" />
                      <span class="mono">{q.mhz}</span>
                      <span class="tag" class:dim={q.digital}>{q.label}</span>
                      {#if q.mobile}<span class="tag mob" title={MOBILE}>mobile</span>{/if}
                    </label>
                  </li>
                {/each}
              </ul>
            </section>
          {/each}
        </div>
      {/if}
    </div>
  </div>
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
</div>
<div class="feet">
  {#if nearby.showLic}<DataFooter data={sites} here={siteHere} inline />{/if}
  {#if nearby.showAir}<DataFooter data={airportSites} here={airHere} inline />{/if}
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
  .dot.dig {
    background: var(--map-dig);
  }
  .dot.pick {
    background: var(--map-pick);
  }
  .dot.you {
    background: var(--blue);
  }
  .dig {
    display: inline-flex;
    gap: 6px;
    align-items: center;
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
  .pop label:hover {
    background: var(--raised);
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
  .tag.dim {
    opacity: 0.7;
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
  .map :global(.nm-pin.dig) {
    background: var(--map-dig);
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
</style>
