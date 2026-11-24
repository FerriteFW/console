<script lang="ts">
  // Near me's Add bar (under the list, and in the map's Picked column: `side`): the licensed sites' options (RX only,
  // the mode for an unknown one) when Licensed shows, the zone target and Add. Add takes the picks shown
  // (nearby.svelte.ts: list and map share them); picks of a hidden kind are counted apart, not added.
  import { nearby } from "../../nearby.svelte";
  import ZoneTarget from "./ZoneTarget.svelte";

  let { each, onadded, side = false }: { each: string; onadded: () => void; side?: boolean } = $props();

  const n = $derived(nearby.items.length);
  const nSites = $derived(nearby.pickedSites.length);
  const nAir = $derived(nearby.pickedAirports.reduce((k, x) => k + x.freqs.length, 0) + nearby.nCommon);
  const nRpt = $derived(nearby.pickedRepeaters.reduce((k, x) => k + x.freqs.length, 0));
  const summary = $derived(
    [nSites ? `${nSites} licensed` : "", nAir ? `${nAir} airport (NAM, RX only)` : "", nRpt ? `${nRpt} repeater (shift and tones)` : ""]
      .filter(Boolean)
      .join(" · "),
  );

  function add() {
    nearby.add();
    onadded();
  }
</script>

{#if nearby.showLic}
  <div class="opts">
    <label title="Licensed sites are other licensees' channels: listen only"><input type="checkbox" bind:checked={nearby.rxOnly} /> {side ? "RX only (licensed sites)" : "RX only (listen; these are other licensees' channels)"}</label>
    <label>
      Unknown mode as
      <select bind:value={nearby.mode} title="For sites whose mode the licence doesn't say; the others take theirs (NFM or FM)"><option>NFM</option><option>FM</option></select>
    </label>
  </div>
{/if}
<div class="foot" class:side>
  <ZoneTarget bind:value={nearby.target} {each} />
  <span class="spacer"></span>
  {#if summary}<span class="sub">{summary}</span>{/if}
  {#if nearby.nHidden}<span class="sub hidden" title="Picked while showing another kind or source: shown again, they're added too">{nearby.nHidden} more picked but hidden, not added</span>{/if}
  <button class="btn primary" disabled={!n} onclick={add}>Add {n} {n === 1 ? "channel" : "channels"}</button>
</div>

<style>
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
  select {
    font: inherit;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 7px;
    padding: 4px 8px;
  }
  .foot {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
    border-top: 1px solid var(--line);
    padding-top: 12px;
  }
  .foot.side {
    flex-direction: column;
    align-items: stretch;
  }
  .foot.side .spacer {
    display: none;
  }
  .spacer {
    flex: 1;
  }
  .sub {
    color: var(--sub);
    font-size: 12px;
  }
</style>
