<script lang="ts">
  // APRS › Waypoints (GPS-10, LINK-55): the places the radio keeps (marked there, saved from an APRS station, sent
  // from here, or typed as a grid square), newest first, up to 256. Name and position edited here (degrees or a grid
  // square, parsed by the core as a channel's position is), checked as the radio checks them; added ones go on top.
  // A tab of APRS beside the map, which shows them as a layer of their own: they are places, as the stations are.
  import ListPage from "../components/ListPage.svelte";
  import ListDetail from "../components/ListDetail.svelte";
  import { degrees, SOURCE_WORDS, waypoints, type WaypointItem } from "../lists.svelte";
  import { loadCore, parsePosition, positionView } from "../core";
  import { aprs, compass, distance } from "../aprs.svelte";
  import { href } from "../route.svelte";
  import { radio } from "../radio.svelte";

  // Rows show the core's checks and words: drawn once it has loaded (a reload straight to this tab).
  let coreUp = $state(false);
  void loadCore().then(() => (coreUp = true));

  let picked = $state<string | null>(null);
  let notice = $state<{ text: string; undo: boolean } | null>(null);
  let search = $state("");
  let posNote = $state("");

  const items = $derived.by(() => {
    const q = search.trim().toLowerCase();
    return waypoints.items.filter((w) => !q || w.name.toLowerCase().includes(q));
  });
  const keyOf = (w: WaypointItem) => String(w.key);
  const base = $derived(new Map((waypoints.base ?? []).map((w) => [w.key, w])));
  const rowClass = (w: WaypointItem) => {
    const b = base.get(w.key);
    return !b ? (waypoints.base ? "added" : "") : b.name !== w.name || b.lat !== w.lat || b.lon !== w.lon ? "changed" : "";
  };
  const where = (w: WaypointItem) => positionView(degrees(w));
  const away = (w: WaypointItem) => {
    if (!aprs.me) return "";
    const [lat, lon] = degrees(w);
    const d = distance(aprs.me, { lat, lon });
    return `${d.km < 10 ? d.km.toFixed(1) : d.km.toFixed(0)} km ${compass(d.deg)}`;
  };

  function add() {
    const from: [number, number] = aprs.me ? [aprs.me.lat, aprs.me.lon] : waypoints.items[0] ? degrees(waypoints.items[0]) : [0, 0];
    const n = waypoints.items.length + 1;
    search = "";
    picked = String(waypoints.add(`Waypoint ${n}`, from));
    queueMicrotask(() => document.querySelector<HTMLInputElement>("input[aria-label='Waypoint name']")?.select());
  }

  function remove(w: WaypointItem) {
    waypoints.remove(w.key);
    notice = { text: `Deleted waypoint "${w.name}".`, undo: true };
  }

  function setPos(w: WaypointItem, e: Event) {
    const el = e.currentTarget as HTMLInputElement;
    try {
      const p = parsePosition(el.value);
      if (!p.pos) throw new Error("A waypoint needs a position: degrees (45.4215, -75.6972) or a grid square (FN25dk).");
      posNote = "";
      waypoints.edit(w.key, { lat: Math.round(p.pos[0] * 1e7), lon: Math.round(p.pos[1] * 1e7) });
      el.value = p.text;
    } catch (err) {
      posNote = (err as Error).message;
    }
  }
  $effect(() => {
    void picked;
    posNote = "";
  });
  // Distances from the radio: its place, asked once a connection (the APRS pages ask too).
  let asked: unknown = null;
  $effect(() => {
    const l = radio.connectedLink;
    if (l && asked !== l && !aprs.me) {
      asked = l;
      void aprs.position();
    }
  });
</script>

<ListPage store={waypoints} label="Waypoints" bind:notice>
  {#snippet find()}
    <input type="search" placeholder="Find a waypoint" aria-label="Find a waypoint" bind:value={search} />
  {/snippet}
  {#if coreUp}
  <ListDetail
    title="Waypoints"
    count={`${waypoints.items.length}/${waypoints.max}`}
    {items}
    id={keyOf}
    bind:picked
    detailLabel={(w) => w.name || "(no name)"}
    {rowClass}
    add={add}
    addDisabled={waypoints.items.length >= waypoints.max}
    addTitle="A new waypoint on top (the newest), at this radio's position"
    empty={search ? "No waypoint matches." : waypoints.base ? "No waypoints yet: add one, or mark one on the radio (GPS)." : "Read the radio to see its waypoints, or add one."}
    pick="Choose a waypoint."
  >
    {#snippet row(w)}
      <span class="nm">{w.name || "(no name)"}</span>
      {#if waypoints.problem(w)}<span class="warn" title={waypoints.problem(w)}>!</span>{/if}
      <span class="side">{away(w) || where(w).grid}</span>
    {/snippet}
    {#snippet header(w)}
      <a class="btn quiet" href={href("aprs-map", { wp: w.name })} title="This waypoint on the APRS map">Map</a>
      <button class="btn danger" aria-label={`Delete waypoint ${w.name}`} title="Delete this waypoint (undoable)" onclick={() => remove(w)}>Delete</button>
    {/snippet}
    {#snippet detail(w)}
      {#if waypoints.problem(w)}<p class="problem" role="alert">{waypoints.problem(w)}</p>{/if}
      {#key w.key}
        <div class="form">
          <label>
            <span>Name</span>
            <input value={w.name} maxlength="16" onchange={(e) => waypoints.edit(w.key, { name: e.currentTarget.value })} aria-label="Waypoint name" />
          </label>
          <label>
            <span>Position</span>
            <input
              class="mono"
              value={where(w).text}
              onchange={(e) => setPos(w, e)}
              aria-label="Waypoint position"
              aria-invalid={!!posNote}
              placeholder="lat, lon or grid square"
              title="Degrees, north and east positive (45.4215, -75.6972), or a grid square (FN25dk)"
            />
          </label>
        </div>
      {/key}
      {#if posNote}
        <p class="err small" role="alert">{posNote}</p>
      {:else}
        <p class="sub small" data-testid="waypoint-grid">📍 Grid square {where(w).grid}{#if away(w)} · {away(w)} from the radio{/if}</p>
      {/if}
      <p class="sub small">Name: 1 to 16 letters, digits and symbols. Position: degrees, north and east positive, or a grid square.</p>
      <dl>
        <dt>Source</dt>
        <dd data-testid="waypoint-source">{SOURCE_WORDS[w.source] ?? w.source}</dd>
      </dl>
      <p class="sub small">On the radio: GPS › Waypoints lists them, newest first, with the distance and bearing to each.</p>
    {/snippet}
  </ListDetail>
  {/if}
</ListPage>

<style>
  .problem {
    margin: 10px 0 0;
    padding: 6px 10px;
    border: 1px solid var(--red);
    border-radius: 6px;
    color: var(--red);
  }
  .form {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr);
    gap: 10px;
    margin-top: 12px;
  }
  @container (max-width: 480px) {
    .form {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  label > span,
  dt {
    color: var(--sub);
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  input {
    height: 32px;
    padding: 0 8px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--bg);
    color: var(--text);
    font: inherit;
    min-width: 0;
  }
  .mono {
    font-family: "JetBrains Mono", monospace;
  }
  .small {
    font-size: 12px;
    margin: 6px 0 0;
  }
  .err {
    color: var(--red);
  }
  dl {
    margin: 14px 0 0;
  }
  dd {
    margin: 2px 0 0;
  }
  .btn.danger {
    color: var(--red);
  }
  .btn.danger:hover {
    border-color: var(--red);
  }
  a.btn {
    text-decoration: none;
  }
</style>
