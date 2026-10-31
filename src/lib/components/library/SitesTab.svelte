<script lang="ts">
  // Licensed sites near a place, as a list: Canada (ISED's TAFL) and the US (the FCC's ULS), tiled from
  // data.ferritefw.dev (sites.svelte.ts). By category (chips with counts switch each on or off; public safety first),
  // then by organization (the licensees' names grouped: nearest first), one entry per organization and frequency
  // (its nearest site; how many sites share it). A group's box takes the whole organization. RX only by default:
  // these are other people's licensed channels. Each row's mode comes from the data (NFM or FM; digital only never
  // shows; unknown takes the "unknown mode" choice). The rows, the picks are nearby.svelte.ts's, shared with the map
  // and the Airports list; Add and the data footers are Near me's (NearbyTab). Canada and the US switched off there
  // leave the list too.
  import { library } from "../../library.svelte";
  import { sites, sourceName } from "../../sites.svelte";
  import { CATEGORIES, CAT_PUBLIC_SAFETY } from "../../sitedata";
  import { MOBILE, mhz, modeLabel, nearby, type SiteEntry } from "../../nearby.svelte";

  const result = $derived(nearby.siteResult);
  let open = $state<Set<string>>(new Set());
  /** Categories switched off (all on to start). */
  let off = $state<Set<number>>(new Set());
  /** Category codes in the order they show: public safety first, then the rest by code. */
  const ORDER = [CAT_PUBLIC_SAFETY, ...CATEGORIES.map((_, k) => k).filter((k) => k !== CAT_PUBLIC_SAFETY)];

  type Group = { id: string; name: string; km: number; es: SiteEntry[] };
  const entries = $derived(nearby.siteShown);
  /** The sources with rows here (a place near the border has both). */
  const here = $derived(new Set(entries.map((e) => e.src)));
  /** The entries the filter keeps: organization, licensee or category name, or the start of the MHz. */
  const matching = $derived.by(() => {
    return nearby.query.trim() ? entries.filter(nearby.matchSite) : entries;
  });
  /** Each category's count (for its chip), and its organizations' groups (nearest first, frequencies in order). */
  const cats = $derived.by(() => {
    const by = new Map<number, Map<string, Group>>();
    for (const e of matching) {
      let gs = by.get(e.k);
      if (!gs) by.set(e.k, (gs = new Map()));
      let g = gs.get(e.group);
      if (!g) gs.set(e.group, (g = { id: `${e.k}|${e.group}`, name: e.group, km: e.km, es: [] }));
      g.es.push(e);
      g.km = Math.min(g.km, e.km);
    }
    return ORDER.filter((k) => by.has(k)).map((k) => {
      const groups = [...by.get(k)!.values()].sort((a, b) => a.km - b.km || a.name.localeCompare(b.name));
      for (const g of groups) g.es.sort((a, b) => a.f - b.f);
      return { k, name: CATEGORIES[k] ?? "Other", n: groups.reduce((n, g) => n + g.es.length, 0), groups };
    });
  });
  const shown = $derived(cats.filter((c) => !off.has(c.k)));
  const nPicked = $derived(nearby.pickedSites.length);

  function flip(id: string) {
    const n = new Set(open);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    open = n;
  }
  function toggleCat(k: number) {
    const n = new Set(off);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    off = n;
  }
  const km = (x: number) => (x < 10 ? x.toFixed(1) : String(Math.round(x)));
  const sitesNote = (e: SiteEntry) => (e.sites > 1 ? `${e.sites} sites · ` : "");

  const failed = $derived(result?.failed ?? []);
  /** Nothing to show at all: the data couldn't be reached and nothing is kept. */
  const down = $derived(!!result && !result.sources.length && failed.length > 0 && failed.length >= sites.sources.length);
</script>

{#if nearby.show === "both"}<h3 class="kind">Licensed sites</h3>{/if}
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
    <input class="find" type="search" placeholder="Search: name, category or MHz" bind:value={nearby.query} aria-label="Filter licensed sites" />
    <span>{entries.length} near{nearby.siteCapped ? " (the nearest only: make the radius smaller)" : ""} · {nPicked} picked</span>
    <span class="spacer"></span>
    <button class="btn quiet sm" onclick={() => nearby.set(shown.flatMap((c) => c.groups.flatMap((g) => g.es.map((e) => e.key))), true)}>All shown</button>
    <button class="btn quiet sm" onclick={() => nearby.set(entries.map((e) => e.key), false)}>None</button>
  </div>
  {#if cats.length}
    <div class="cats" role="group" aria-label="Categories">
      {#each cats as c (c.k)}
        <button class="chip" aria-pressed={!off.has(c.k)} onclick={() => toggleCat(c.k)} title="Show or hide {c.name.toLowerCase()}">{c.name} <span class="n">{c.n}</span></button>
      {/each}
    </div>
  {/if}
  {#if failed.length}
    <p class="warn">{failed.map((f) => `${sourceName(f.src, sites.source(f.src)?.title)}: ${f.error}`).join(" · ")}</p>
  {/if}
  <div class="list" aria-label="Licensed sites near the place">
    {#each shown as c (c.k)}
      <h4 class="cat">{c.name}</h4>
      {#each c.groups as g (g.id)}
        {@const all = g.es.every((e) => nearby.has(e.key))}
        {@const some = g.es.some((e) => nearby.has(e.key))}
        <div class="grp">
          <div class="gh">
            <input type="checkbox" checked={all} indeterminate={some && !all} onchange={() => nearby.set(g.es.map((e) => e.key), !all)} aria-label={`Group ${g.name}`} />
            {#if g.es.length > 1}
              <button class="tw" onclick={() => flip(g.id)} aria-expanded={open.has(g.id)}>{open.has(g.id) ? "▾" : "▸"} <b>{g.name}</b> <span class="sub">{g.es.length} frequencies · {km(g.km)} km</span></button>
            {:else}
              {@const e = g.es[0]}
              <span class="one">
                <b>{g.name}</b> <span class="mhz">{mhz(e.f)}</span> <span class="tag">{modeLabel(e.m)}</span>
                {#if e.mobile}<span class="tag mob" title={MOBILE}>mobile</span>{/if}
                {#if here.size > 1}<span class="sub">{sourceName(e.src)}</span>{/if}
                <span class="sub">{sitesNote(e)}{km(e.km)} km</span>
              </span>
            {/if}
          </div>
          {#if g.es.length > 1 && open.has(g.id)}
            {#each g.es as e (e.key)}
              <label class="en">
                <input type="checkbox" checked={nearby.has(e.key)} onchange={() => nearby.toggle(e.key)} />
                <span>{e.name}</span><span class="mhz">{mhz(e.f)}</span>
                <span><span class="tag">{modeLabel(e.m)}</span>{#if e.mobile}&nbsp;<span class="tag mob" title={MOBILE}>mobile</span>{/if}</span>
                <span class="sub">{here.size > 1 ? `${sourceName(e.src)} · ` : ""}{sitesNote(e)}{km(e.km)} km</span>
              </label>
            {/each}
          {/if}
        </div>
      {/each}
    {:else}
      <p class="sub pad">
        Nothing within {library.radius} km{nearby.query.trim() || off.size ? " matches" : ""}.
      </p>
    {/each}
  </div>
{/if}

<style>
  .kind {
    margin: 0;
    font-size: 12px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--sub);
  }
  .head {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 12px;
    color: var(--sub);
  }
  .find {
    font: inherit;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 7px;
    padding: 4px 8px;
  }
  .find {
    width: 240px;
  }
  .cats {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip {
    font: inherit;
    font-size: 12px;
    display: inline-flex;
    gap: 6px;
    align-items: center;
    background: var(--raised);
    color: var(--text);
    border: 1px solid var(--line);
    border-radius: 7px;
    padding: 2px 9px;
    cursor: pointer;
  }
  .chip[aria-pressed="false"] {
    color: var(--sub);
    background: none;
  }
  .chip .n {
    color: var(--sub);
  }
  .cat {
    margin: 6px 6px 2px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--sub);
  }
  .cat:first-child {
    margin-top: 2px;
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
    grid-template-columns: auto minmax(140px, 200px) 90px 120px 1fr;
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
  .tag.mob {
    border-style: dashed;
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
