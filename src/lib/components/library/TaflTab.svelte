<script lang="ts">
  // Canadian licensed sites near a place (ISED's TAFL, as NeonPlug has it): licensee names grouped by their first
  // words, one channel per name and frequency. RX only by default: these are other people's licensed channels.
  import { library } from "../../library.svelte";
  import { channels } from "../../channels.svelte";
  import { near, taflGroups, type LibraryItem } from "../../core";
  import PlacePicker from "./PlacePicker.svelte";
  import ZoneTarget, { zoneName, type Target } from "./ZoneTarget.svelte";

  let { onadded }: { onadded: () => void } = $props();

  library.loadTafl();
  let filter = $state("");
  let picked = $state<Set<string>>(new Set());
  let open = $state<Set<string>>(new Set());
  let rxOnly = $state(true);
  let mode = $state<"NFM" | "FM">("NFM");
  let target = $state<Target>({ kind: "each", name: "TAFL", existing: 0 });

  type Entry = { key: string; name: string; khz: number; km: number; group: string; pos: [number, number] };
  /** Near entries, one per name and frequency (the nearest), grouped. */
  const entries = $derived.by((): Entry[] => {
    const d = library.tafl;
    const p = library.place;
    if (!d || !p) return [];
    const seen = new Set<string>();
    const out: Omit<Entry, "group">[] = [];
    for (const { i, km } of near(p, library.radius, d.coords, 5000)) {
      const r = d.rows[i];
      const key = `${r.c}|${r.f}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, name: r.c, khz: r.f, km, pos: r.l });
    }
    const groups = taflGroups(out.map((e) => e.name));
    return out.map((e, k) => ({ ...e, group: groups[k] }));
  });
  const shown = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    const list = q ? entries.filter((e) => e.name.toLowerCase().includes(q) || (e.khz / 1000).toFixed(4).startsWith(q)) : entries;
    const g = new Map<string, Entry[]>();
    for (const e of list) g.set(e.group, [...(g.get(e.group) ?? []), e]);
    return [...g.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  });

  function set(keys: string[], on: boolean) {
    const n = new Set(picked);
    for (const k of keys) {
      if (on) n.add(k);
      else n.delete(k);
    }
    picked = n;
  }
  function flip(g: string) {
    const n = new Set(open);
    if (n.has(g)) n.delete(g);
    else n.add(g);
    open = n;
  }
  const mhz = (khz: number) => (khz / 1000).toFixed(4).replace(/0$/, "");

  function add() {
    const zones = channels.table.zones;
    const sel = entries.filter((e) => picked.has(e.key));
    // One channel per zone and frequency: the licensees sharing it named on the first.
    const byZf = new Map<string, { e: Entry; more: number; zone: string }>();
    for (const e of sel) {
      const zone = zoneName(target, e.group, zones);
      const k = `${zone}|${e.khz}`;
      const was = byZf.get(k);
      if (was) was.more++;
      else byZf.set(k, { e, more: 0, zone });
    }
    const items: LibraryItem[] = [...byZf.values()].map(({ e, more, zone }) => ({
      name: more ? `${e.name.slice(0, 12).trimEnd()} +${more}` : e.name,
      rx: e.khz / 1000,
      mode,
      power: "Low",
      rx_only: rxOnly,
      zone,
      pos: e.pos, // the site's licensed position (LINK-53: the channel's)
    }));
    library.add(items, `TAFL (${sel.length} ${sel.length === 1 ? "licence" : "licences"})`);
    picked = new Set();
    onadded();
  }
</script>

<PlacePicker />
{#if !library.tafl}
  <p class="sub">
    Loading TAFL (11 MB, once)…{#if library.loading && library.loading.total}&nbsp;{Math.round((100 * library.loading.done) / library.loading.total)}%{:else if library.loading}&nbsp;{Math.round(library.loading.done / 1048576)} MB{/if}
  </p>
{:else if !library.place}
  <p class="sub">{library.tafl.rows.length.toLocaleString()} licensed VHF and UHF sites in Canada. Give a place to list the ones near it.</p>
{:else}
  <div class="head">
    <input class="find" type="search" placeholder="Filter: name or MHz" bind:value={filter} aria-label="Filter TAFL entries" />
    <span>{entries.length} near · {picked.size} picked</span>
    <span class="spacer"></span>
    <button class="btn quiet sm" onclick={() => set(shown.flatMap(([, es]) => es.map((e) => e.key)), true)}>All shown</button>
    <button class="btn quiet sm" onclick={() => (picked = new Set())}>None</button>
  </div>
  <div class="list" aria-label="TAFL entries">
    {#each shown as [g, es] (g)}
      {@const all = es.every((e) => picked.has(e.key))}
      {@const some = es.some((e) => picked.has(e.key))}
      <div class="grp">
        <div class="gh">
          <input type="checkbox" checked={all} indeterminate={some && !all} onchange={() => set(es.map((e) => e.key), !all)} aria-label={`Group ${g}`} />
          {#if es.length > 1}
            <button class="tw" onclick={() => flip(g)} aria-expanded={open.has(g)}>{open.has(g) ? "▾" : "▸"} <b>{g}</b> <span class="sub">{es.length} entries · {Math.round(es[0].km)} km</span></button>
          {:else}
            <span class="one"><b>{es[0].name}</b> <span class="mhz">{mhz(es[0].khz)}</span> <span class="sub">{es[0].km.toFixed(1)} km</span></span>
          {/if}
        </div>
        {#if es.length > 1 && open.has(g)}
          {#each es as e (e.key)}
            <label class="en">
              <input type="checkbox" checked={picked.has(e.key)} onchange={() => set([e.key], !picked.has(e.key))} />
              <span>{e.name}</span><span class="mhz">{mhz(e.khz)}</span><span class="sub">{e.km.toFixed(1)} km</span>
            </label>
          {/each}
        {/if}
      </div>
    {:else}
      <p class="sub pad">Nothing within {library.radius} km{filter ? " matches" : ""}.</p>
    {/each}
  </div>
{/if}
<div class="opts">
  <label><input type="checkbox" bind:checked={rxOnly} /> RX only (listen; these are other licensees' channels)</label>
  <label>Mode <select bind:value={mode}><option>NFM</option><option>FM</option></select></label>
</div>
<div class="foot">
  <ZoneTarget bind:value={target} each="One zone per name group" />
  <span class="spacer"></span>
  <button class="btn primary" disabled={!picked.size} onclick={add}>Add {picked.size} {picked.size === 1 ? "entry" : "entries"}</button>
</div>

<style>
  .head {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 12px;
    color: var(--sub);
  }
  .find,
  select {
    font: inherit;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 7px;
    padding: 4px 8px;
  }
  .find {
    width: 200px;
  }
  .sm {
    padding: 3px 10px;
    font-size: 12px;
  }
  .list {
    flex: 1;
    min-height: 120px;
    overflow: auto;
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 4px;
    font-size: 13px;
  }
  .gh {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 3px 6px;
    border-radius: 5px;
  }
  .gh:hover {
    background: var(--raised);
  }
  .tw {
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    text-align: left;
  }
  .en {
    display: grid;
    grid-template-columns: auto minmax(140px, 200px) 90px auto;
    gap: 10px;
    padding: 2px 6px 2px 34px;
    cursor: pointer;
  }
  .mhz {
    font-variant-numeric: tabular-nums;
  }
  .opts {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 18px;
    font-size: 13px;
  }
  .opts label {
    display: inline-flex;
    gap: 8px;
    align-items: center;
  }
  .foot {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
    border-top: 1px solid var(--line);
    padding-top: 12px;
  }
  .spacer {
    flex: 1;
  }
  .sub {
    color: var(--sub);
    font-size: 12px;
  }
  .pad {
    padding: 12px;
  }
</style>
