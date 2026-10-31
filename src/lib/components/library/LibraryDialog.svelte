<script lang="ts">
  // "Add channels": the channel library beside CHIRP import. Fixed sets; Near me: licensed sites and airports near a
  // place (ported from NeonPlug), on the map or as a list (NearbyTab); repeaters not yet (see the tab). Near me makes
  // the dialog nearly as big as the window (a desktop app's feel: the map gets the room), in both its views so
  // switching between them doesn't jump.
  // Added channels go into the table as new rows, checked by ferrite's own code; Write then shows them in the diff
  // as usual.
  import { library } from "../../library.svelte";
  import FixedTab from "./FixedTab.svelte";
  import NearbyTab from "./NearbyTab.svelte";
  import { channels } from "../../channels.svelte";

  const tabs = [
    { id: "fixed", label: "Fixed sets", sub: "FRS, GMRS, MURS, PMR446, marine, weather, airband, resource roads, calling" },
    { id: "near", label: "Near me", sub: "Licensed sites (Canada, the US) and airports near a place, on a map" },
    { id: "repeaters", label: "Repeaters", sub: "Not yet" },
  ] as const;

  const room = $derived(1000 - channels.table.channels.length);
  const close = () => (library.open = false);
  function key(e: KeyboardEvent) {
    if (e.key === "Escape" && library.open) close();
  }
</script>

<svelte:window onkeydown={key} />

{#if library.open}
  <div class="overlay" role="presentation" onclick={(e) => e.target === e.currentTarget && close()}>
    <div class="dialog card" class:big={library.tab === "near"} role="dialog" aria-modal="true" aria-labelledby="lib-title">
      <header>
        <h2 id="lib-title">Add channels</h2>
        <span class="sub">{channels.table.channels.length} in the table · room for {room} more · {channels.table.zones.length} zones</span>
        <span class="spacer"></span>
        <button class="x" onclick={close} aria-label="Close">✕</button>
      </header>
      <div class="body">
        <div class="nav" role="tablist" aria-label="Sources">
          {#each tabs as t (t.id)}
            <button role="tab" aria-selected={library.tab === t.id} class:on={library.tab === t.id} onclick={() => (library.tab = t.id)}>
              <b>{t.label}</b><span>{t.sub}</span>
            </button>
          {/each}
          <p class="note">Added channels land in the table as new rows (green). Nothing goes to the radio until Write, which backs up and shows the diff first.</p>
        </div>
        <div class="panel" role="tabpanel" aria-label={tabs.find((t) => t.id === library.tab)?.label}>
          {#if library.error}<div class="banner">{library.error}</div>{/if}
          {#if library.tab === "fixed"}
            <FixedTab onadded={close} />
          {:else if library.tab === "near"}
            <NearbyTab onadded={close} />
          {:else}
            <div class="stub">
              <h3>Repeaters: not yet</h3>
              <p>NeonPlug's repeater source is RadioID's DMR list (<code>rptrs.json</code>). It doesn't fit Ferrite:</p>
              <ul>
                <li>Ferrite is analog. DMR repeaters are useless to it.</li>
                <li>Only about 1,100 of its 11,500 entries are mixed mode (analog too).</li>
                <li>The list has no access tones. Most analog repeaters need one.</li>
                <li>The list has no coordinates, so "near a place" can't work.</li>
              </ul>
              <p>RepeaterBook has the right data, but its API needs a key and its terms limit reuse.</p>
              <p>For now: export from RepeaterBook or CHIRP as CHIRP CSV, then <b>CHIRP CSV › Import</b>.</p>
            </div>
          {/if}
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgb(0 0 0 / 0.55);
    display: grid;
    place-items: center;
    z-index: 20;
    padding: 16px;
  }
  .dialog {
    width: min(1100px, 100%);
    height: min(760px, calc(100vh - 32px));
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 14px 16px;
  }
  .dialog.big {
    width: min(96vw, calc(100vw - 32px), 1800px);
    height: min(92vh, calc(100vh - 32px), 1200px);
  }
  .big .body {
    grid-template-columns: 190px 1fr;
  }
  header {
    display: flex;
    gap: 12px;
    align-items: baseline;
  }
  h2 {
    margin: 0;
    font-size: 17px;
  }
  .spacer {
    flex: 1;
  }
  .x {
    background: none;
    border: none;
    color: var(--sub);
    cursor: pointer;
    font-size: 16px;
    padding: 2px 6px;
    border-radius: 5px;
  }
  .x:hover {
    color: var(--text);
    background: var(--raised);
  }
  .body {
    display: grid;
    grid-template-columns: 220px 1fr;
    gap: 16px;
    flex: 1;
    min-height: 0;
  }
  .nav {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .nav button {
    text-align: left;
    background: none;
    border: 1px solid transparent;
    border-left: 3px solid transparent;
    border-radius: 6px;
    padding: 8px 10px;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .nav button span {
    color: var(--sub);
    font-size: 11px;
    line-height: 1.3;
  }
  .nav button:hover {
    background: var(--raised);
  }
  .nav button.on {
    background: var(--focus);
    border-left-color: var(--blue);
  }
  .note {
    margin-top: auto;
    color: var(--sub);
    font-size: 11px;
    line-height: 1.4;
  }
  .panel {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-height: 0;
    min-width: 0;
  }
  .banner {
    padding: 6px 10px;
    border: 1px solid var(--red);
    border-radius: 8px;
    color: var(--red);
    font-size: 13px;
  }
  .stub {
    max-width: 640px;
    font-size: 13px;
  }
  .stub h3 {
    margin: 4px 0 10px;
    font-size: 15px;
  }
  .stub ul {
    padding-left: 20px;
    color: var(--sub);
  }
  .sub {
    color: var(--sub);
    font-size: 12px;
  }
  @media (max-width: 760px) {
    .dialog,
    .dialog.big {
      height: calc(100vh - 32px);
    }
    .body,
    .big .body {
      grid-template-columns: 1fr;
      grid-template-rows: auto 1fr;
    }
    .nav {
      flex-direction: row;
      overflow-x: auto;
    }
    .nav button span,
    .note {
      display: none;
    }
  }
</style>
