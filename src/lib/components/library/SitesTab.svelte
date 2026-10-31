<script lang="ts">
  // Licensed sites near a place, as a list: Canada (ISED's TAFL) and the US (the FCC's ULS), tiled from
  // data.ferritefw.dev (sites.svelte.ts). Licensee names grouped by their first words, one entry per name and
  // frequency. RX only by default: these are other people's licensed channels. Each row's mode comes from the data
  // (NFM or FM; digital only is hidden unless asked for; unknown takes the "unknown mode" choice). The rows, the
  // picks and Add are nearby.svelte.ts's, shared with the map and the Airports list. The footer has each source's
  // attribution, its offline copy ("Save for offline") and the update the server offers.
  import { library } from "../../library.svelte";
  import { sites, sourceName } from "../../sites.svelte";
  import { MODE_DIGITAL } from "../../sitedata";
  import { MOBILE, mhz, modeLabel, nearby, type SiteEntry } from "../../nearby.svelte";
  import DataFooter from "./DataFooter.svelte";
  import AddBar from "./AddBar.svelte";

  let { onadded }: { onadded: () => void } = $props();

  const result = $derived(nearby.siteResult);
  let filter = $state("");
  let open = $state<Set<string>>(new Set());

  const entries = $derived(nearby.siteEntries);
  const nDigital = $derived(nearby.nDigital);
  /** The sources with rows here (a place near the border has both). */
  const here = $derived(new Set(entries.map((e) => e.src)));
  const shown = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    const list = q ? entries.filter((e) => e.name.toLowerCase().includes(q) || mhz(e.f).startsWith(q)) : entries;
    const g = new Map<string, SiteEntry[]>();
    for (const e of list) g.set(e.group, [...(g.get(e.group) ?? []), e]);
    return [...g.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  });
  const nPicked = $derived(nearby.pickedSites.length);

  function flip(g: string) {
    const n = new Set(open);
    if (n.has(g)) n.delete(g);
    else n.add(g);
    open = n;
  }

  const failed = $derived(result?.failed ?? []);
  /** Nothing to show at all: the data couldn't be reached and nothing is kept. */
  const down = $derived(!!result && !result.sources.length && failed.length > 0 && failed.length >= sites.sources.length);
</script>

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
    <span>{entries.length} near · {nPicked} picked</span>
    <label class="dig">
      <input type="checkbox" bind:checked={nearby.digital} title="Sites licensed for digital or data only (no analog voice)" /> Show digital only ({nDigital})
    </label>
    <span class="spacer"></span>
    <button class="btn quiet sm" onclick={() => nearby.set(shown.flatMap(([, es]) => es.map((e) => e.key)), true)}>All shown</button>
    <button class="btn quiet sm" onclick={() => nearby.set(entries.map((e) => e.key), false)}>None</button>
  </div>
  {#if failed.length}
    <p class="warn">{failed.map((f) => `${sourceName(f.src, sites.source(f.src)?.title)}: ${f.error}`).join(" · ")}</p>
  {/if}
  <div class="list" aria-label="Licensed sites near the place">
    {#each shown as [g, es] (g)}
      {@const all = es.every((e) => nearby.has(e.key))}
      {@const some = es.some((e) => nearby.has(e.key))}
      <div class="grp">
        <div class="gh">
          <input type="checkbox" checked={all} indeterminate={some && !all} onchange={() => nearby.set(es.map((e) => e.key), !all)} aria-label={`Group ${g}`} />
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
              <input type="checkbox" checked={nearby.has(e.key)} onchange={() => nearby.toggle(e.key)} />
              <span>{e.name}</span><span class="mhz">{mhz(e.f)}</span>
              <span><span class="tag" class:dim={e.m === MODE_DIGITAL}>{modeLabel(e.m)}</span>{#if e.mobile}&nbsp;<span class="tag mob" title={MOBILE}>mobile</span>{/if}</span>
              <span class="sub">{here.size > 1 ? `${sourceName(e.src)} · ` : ""}{e.km.toFixed(1)} km</span>
            </label>
          {/each}
        {/if}
      </div>
    {:else}
      <p class="sub pad">
        Nothing within {library.radius} km{filter ? " matches" : ""}.{#if !nearby.digital && nDigital}&nbsp;{nDigital} digital-only {nDigital === 1 ? "site is" : "sites are"} hidden.{/if}
      </p>
    {/each}
  </div>
{/if}
<AddBar each="One zone per name group" licensed {onadded} />
<DataFooter data={sites} {here} />

<style>
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
