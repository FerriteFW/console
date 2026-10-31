<script lang="ts">
  // The footer of a tab whose data comes from data.ferritefw.dev (Licensed sites, Airports): each source's date, the
  // update the server offers, its offline copy ("Save for offline") and its attribution line.
  import { library } from "../../library.svelte";
  import { sourceName, type Sites } from "../../sites.svelte";

  /** `here`: the sources with rows near the place (only theirs show attribution once a place is given). */
  /** `inline`: each source's line and attribution run on as one paragraph (the map, short of height). */
  let { data, here, inline = false }: { data: Sites; here: Set<string>; inline?: boolean } = $props();

  const mb = (bytes: number) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
</script>

<footer class="data" class:inline aria-label="Channel data">
  {#each data.listed as s (s.source)}
    {@const name = sourceName(s.source, s.title)}
    {@const saving = data.saving?.src === s.source ? data.saving : null}
    <div class="one">
    <div class="src">
      <span><b>{name}</b> · data of {s.source_date}</span>
      {#if data.newer[s.source]}
        <button class="btn quiet sm" disabled={!!data.saving} onclick={() => data.update(s.source)} title={data.offline[s.source] ? `Downloads ${name} again (${mb(s.bundle_bytes)})` : "Loads the new data as you look"}>
          Update channel data ({data.newer[s.source]})
        </button>
      {/if}
      {#if saving}
        <span class="sub" role="status">Saving {name}… {saving.total ? Math.round((100 * saving.done) / saving.total) : 0}% of {mb(saving.total)}</span>
      {:else if data.offline[s.source]}
        <span class="sub">Saved for offline</span>
      {:else if data.canKeep}
        <button class="btn quiet sm" disabled={!!data.saving} onclick={() => data.save(s.source)} title="Downloads all of {name} once, so it works without a connection">
          Save {name} for offline ({mb(s.bundle_bytes)})
        </button>
      {/if}
    </div>
    {#if !library.place || here.has(s.source)}<p class="attr">{s.attribution}</p>{/if}
    </div>
  {/each}
  {#if data.saveError}<p class="warn">{data.saveError}</p>{/if}
</footer>

<style>
  .data {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 11px;
    color: var(--sub);
  }
  .src {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 10px;
    align-items: center;
  }
  .inline .src,
  .inline .attr {
    display: inline;
  }
  .inline .src > * + * {
    margin-left: 6px;
  }
  .inline .attr {
    margin-left: 8px;
  }
  .sm {
    font-size: 11px;
    padding: 1px 8px;
  }
  .attr {
    margin: 0 0 4px;
    line-height: 1.35;
  }
  .warn {
    margin: 0;
    font-size: 12px;
    color: var(--red);
  }
  .sub {
    color: var(--sub);
    font-size: 12px;
  }
</style>
