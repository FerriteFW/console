<script lang="ts">
  // Near me's data line, under the map and the list: one short credit line for the kinds shown, and a Data button
  // that opens the full footers (DataFooter: each source's date, the update the server offers, Save for offline, its
  // attribution) in a popover, so they don't take the screen. The button shows a dot while an update is offered or a
  // save failed. The short line keeps the Open Government Licence's statement in view, as the licence asks.
  import DataFooter from "./DataFooter.svelte";
  import type { Sites } from "../../sites.svelte";

  let { shown }: { shown: { data: Sites; here: Set<string> }[] } = $props();

  /** Each source's credit, short. */
  const CREDIT: Record<string, string> = {
    repeaters: "HearHam",
    tafl: "ISED (Open Government Licence – Canada)",
    fcc: "FCC",
    airports: "OurAirports",
  };
  const credits = $derived(shown.flatMap(({ data }) => data.listed.map((s) => CREDIT[s.source] ?? s.title)));
  const attention = $derived(shown.some(({ data }) => Object.keys(data.newer).length > 0 || !!data.saveError));

  let open = $state(false);
  let el = $state<HTMLElement>();
  function outside(e: MouseEvent) {
    // The event's path, not its target: a button inside can swap itself out as it's clicked (Save -> Saving…).
    if (open && el && !e.composedPath().includes(el)) open = false;
  }
</script>

<svelte:window onclick={outside} />

{#if credits.length}
  <div class="credits" bind:this={el}>
    <span class="line">Data: {credits.join(" · ")}</span>
    <button class="btn quiet sm" class:dot={attention} aria-expanded={open} aria-haspopup="dialog" onclick={() => (open = !open)} title="Each source's date, updates, offline copies and full credits">
      Data{#if attention}<i aria-label="update available"></i>{/if}
    </button>
    {#if open}
      <div class="pop card" role="dialog" aria-label="Channel data sources">
        {#each shown as s (s.data)}
          <DataFooter data={s.data} here={s.here} />
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .credits {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    font-size: 11px;
    color: var(--sub);
  }
  .line {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sm {
    position: relative;
    font-size: 11px;
    padding: 1px 8px;
  }
  .sm i {
    position: absolute;
    top: -3px;
    right: -3px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--blue);
  }
  .pop {
    position: absolute;
    right: 0;
    bottom: calc(100% + 6px);
    z-index: 1000;
    width: min(560px, 90vw);
    max-height: 60vh;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px 14px;
    box-shadow: 0 8px 28px rgb(0 0 0 / 0.25);
  }
</style>
