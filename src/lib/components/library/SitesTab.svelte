<script lang="ts">
  // Licensed sites near a place: Canada (ISED's TAFL) and the US (the FCC's ULS), tiled from data.ferritefw.dev
  // (sites.svelte.ts). Licensee names grouped by their first words, one channel per name and frequency. RX only by
  // default: these are other people's licensed channels. Each row's mode comes from the data (NFM or FM; digital
  // only is hidden unless asked for; unknown takes the tab's mode). The footer has each source's attribution, its
  // offline copy ("Save for offline") and the update the server offers.
  import { library } from "../../library.svelte";
  import { channels } from "../../channels.svelte";
  import { Sites, sites, sourceName } from "../../sites.svelte";
  import { MODE_DIGITAL, MODE_FM, MODE_NFM } from "../../sitedata";
  import { near, taflGroups, type LibraryItem } from "../../core";
  import PlacePicker from "./PlacePicker.svelte";
  import DataFooter from "./DataFooter.svelte";
  import ZoneTarget, { zoneName, type Target } from "./ZoneTarget.svelte";

  let { onadded }: { onadded: () => void } = $props();

  /** The sites for this place and radius (not an earlier place's while the new one loads). */
  const result = $derived.by(() => {
    const p = library.place;
    const d = sites.near;
    return p && d && d.key === Sites.key(p.lat, p.lon, library.radius) ? d : null;
  });

  sites.start();
  $effect(() => {
    const p = library.place;
    if (p) sites.look(p.lat, p.lon, library.radius);
  });

  let filter = $state("");
  let picked = $state<Set<string>>(new Set());
  let open = $state<Set<string>>(new Set());
  let rxOnly = $state(true);
  let digital = $state(false);
  let mode = $state<"NFM" | "FM">("NFM");
  let target = $state<Target>({ kind: "each", name: "Licensed sites", existing: 0 });

  type Entry = { key: string; src: string; name: string; f: number; m: number; mobile: boolean; km: number; group: string; pos: [number, number] };
  /** Near entries, one per name and frequency (the nearest), grouped. */
  const nearAll = $derived.by((): Entry[] => {
    const d = result;
    const p = library.place;
    if (!d || !p) return [];
    const seen = new Set<string>();
    const out: Omit<Entry, "group">[] = [];
    for (const { i, km } of near(p, library.radius, d.coords, 5000)) {
      const r = d.sites[i];
      const key = `${r.name}|${r.f}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, src: r.src, name: r.name, f: r.f, m: r.m, mobile: r.mobile, km, pos: [r.lat, r.lon] });
    }
    const groups = taflGroups(out.map((e) => e.name));
    return out.map((e, k) => ({ ...e, group: groups[k] }));
  });
  const nDigital = $derived(nearAll.filter((e) => e.m === MODE_DIGITAL).length);
  const entries = $derived(digital ? nearAll : nearAll.filter((e) => e.m !== MODE_DIGITAL));
  /** The sources with rows here (a place near the border has both). */
  const here = $derived(new Set(entries.map((e) => e.src)));
  const shown = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    const list = q ? entries.filter((e) => e.name.toLowerCase().includes(q) || mhz(e.f).startsWith(q)) : entries;
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
  /** Half kHz to MHz, 4 decimals (a trailing 0 dropped). */
  const mhz = (f: number) => (f / 2000).toFixed(4).replace(/0$/, "");
  const modeLabel = (m: number) => (m === MODE_NFM ? "NFM" : m === MODE_FM ? "FM" : m === MODE_DIGITAL ? "Digital" : "Mode ?");
  const modeOf = (m: number): "NFM" | "FM" => (m === MODE_NFM ? "NFM" : m === MODE_FM ? "FM" : mode);
  const MOBILE = "A mobile's frequency: often a repeater's input, or the centre of a mobile area";

  function add() {
    const zones = channels.table.zones;
    const sel = entries.filter((e) => picked.has(e.key));
    // One channel per zone and frequency: the licensees sharing it named on the first.
    const byZf = new Map<string, { e: Entry; more: number; zone: string }>();
    for (const e of sel) {
      const zone = zoneName(target, e.group, zones);
      const k = `${zone}|${e.f}`;
      const was = byZf.get(k);
      if (was) was.more++;
      else byZf.set(k, { e, more: 0, zone });
    }
    const items: LibraryItem[] = [...byZf.values()].map(({ e, more, zone }) => ({
      name: more ? `${e.name.slice(0, 12).trimEnd()} +${more}` : e.name,
      rx: e.f / 2000,
      mode: modeOf(e.m),
      power: "Low",
      rx_only: rxOnly,
      zone,
      pos: e.pos, // the site's licensed position (LINK-53: the channel's)
    }));
    library.add(items, `licensed sites (${sel.length} ${sel.length === 1 ? "licence" : "licences"})`);
    picked = new Set();
    onadded();
  }

  const failed = $derived(result?.failed ?? []);
  /** Nothing to show at all: the data couldn't be reached and nothing is kept. */
  const down = $derived(!!result && !result.sources.length && failed.length > 0 && failed.length >= sites.sources.length);
</script>

<PlacePicker />
{#if !library.place}
  <p class="sub">
    {#if sites.top}
      Licensed VHF and UHF sites: {sites.listed.map((s) => `${sourceName(s.source, s.title)} ${s.rows.toLocaleString()}`).join(", ")}. Give a place to list the ones near it.
    {:else if sites.topError}
      Licensed VHF and UHF sites in Canada and the US. Give a place to list the ones near it. (The data isn't reachable right now: {sites.topError}.)
    {:else}
      Loading the licensed sites' index…
    {/if}
  </p>
{:else if down}
  <div class="msg" role="status">
    <b>Licensed sites aren't available right now.</b>
    <span>{failed[0].error}. Places you looked at before, and sources saved for offline, still work.</span>
    <button class="btn quiet sm" onclick={() => sites.retry()}>Try again</button>
  </div>
{:else if !result}
  <p class="sub">Loading licensed sites near the place…</p>
{:else}
  <div class="head">
    <input class="find" type="search" placeholder="Filter: name or MHz" bind:value={filter} aria-label="Filter licensed sites" />
    <span>{entries.length} near · {picked.size} picked</span>
    <label class="dig">
      <input type="checkbox" bind:checked={digital} title="Sites licensed for digital or data only (no analog voice)" /> Show digital only ({nDigital})
    </label>
    <span class="spacer"></span>
    <button class="btn quiet sm" onclick={() => set(shown.flatMap(([, es]) => es.map((e) => e.key)), true)}>All shown</button>
    <button class="btn quiet sm" onclick={() => (picked = new Set())}>None</button>
  </div>
  {#if failed.length}
    <p class="warn">{failed.map((f) => `${sourceName(f.src, sites.source(f.src)?.title)}: ${f.error}`).join(" · ")}</p>
  {/if}
  <div class="list" aria-label="Licensed sites near the place">
    {#each shown as [g, es] (g)}
      {@const all = es.every((e) => picked.has(e.key))}
      {@const some = es.some((e) => picked.has(e.key))}
      <div class="grp">
        <div class="gh">
          <input type="checkbox" checked={all} indeterminate={some && !all} onchange={() => set(es.map((e) => e.key), !all)} aria-label={`Group ${g}`} />
          {#if es.length > 1}
            <button class="tw" onclick={() => flip(g)} aria-expanded={open.has(g)}>{open.has(g) ? "▾" : "▸"} <b>{g}</b> <span class="sub">{es.length} entries · {Math.round(es[0].km)} km</span></button>
          {:else}
            {@const e = es[0]}
            <span class="one">
              <b>{e.name}</b> <span class="mhz">{mhz(e.f)}</span> <span class="tag" class:dim={e.m === MODE_DIGITAL}>{modeLabel(e.m)}</span>
              {#if e.mobile}<span class="tag mob" title={MOBILE}>mobile</span>{/if}
              {#if here.size > 1}<span class="sub">{sourceName(e.src)}</span>{/if}
              <span class="sub">{e.km.toFixed(1)} km</span>
            </span>
          {/if}
        </div>
        {#if es.length > 1 && open.has(g)}
          {#each es as e (e.key)}
            <label class="en">
              <input type="checkbox" checked={picked.has(e.key)} onchange={() => set([e.key], !picked.has(e.key))} />
              <span>{e.name}</span><span class="mhz">{mhz(e.f)}</span>
              <span><span class="tag" class:dim={e.m === MODE_DIGITAL}>{modeLabel(e.m)}</span>{#if e.mobile}&nbsp;<span class="tag mob" title={MOBILE}>mobile</span>{/if}</span>
              <span class="sub">{here.size > 1 ? `${sourceName(e.src)} · ` : ""}{e.km.toFixed(1)} km</span>
            </label>
          {/each}
        {/if}
      </div>
    {:else}
      <p class="sub pad">
        Nothing within {library.radius} km{filter ? " matches" : ""}.{#if !digital && nDigital}&nbsp;{nDigital} digital-only {nDigital === 1 ? "site is" : "sites are"} hidden.{/if}
      </p>
    {/each}
  </div>
{/if}
<div class="opts">
  <label><input type="checkbox" bind:checked={rxOnly} /> RX only (listen; these are other licensees' channels)</label>
  <label>Unknown mode as <select bind:value={mode} title="For sites whose mode the licence doesn't say; the others take theirs (NFM or FM)"><option>NFM</option><option>FM</option></select></label>
</div>
<div class="foot">
  <ZoneTarget bind:value={target} each="One zone per name group" />
  <span class="spacer"></span>
  <button class="btn primary" disabled={!picked.size} onclick={add}>Add {picked.size} {picked.size === 1 ? "entry" : "entries"}</button>
</div>
<DataFooter data={sites} {here} />

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
  .dig {
    display: inline-flex;
    gap: 6px;
    align-items: center;
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
  .one {
    display: inline-flex;
    gap: 8px;
    align-items: baseline;
    flex-wrap: wrap;
  }
  .en {
    display: grid;
    grid-template-columns: auto minmax(140px, 200px) 90px 120px auto;
    gap: 10px;
    padding: 2px 6px 2px 34px;
    cursor: pointer;
  }
  .mhz {
    font-variant-numeric: tabular-nums;
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
  .msg {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 10px;
    align-items: center;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: 8px;
    font-size: 13px;
  }
  .warn {
    margin: 0;
    font-size: 12px;
    color: var(--red);
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
