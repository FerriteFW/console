<script lang="ts">
  // A CHIRP CSV file read by the core, for review before it goes into the table.
  import { channels } from "../channels.svelte";

  let replace = $state(false);
  const imp = $derived(channels.imported);
  const clashes = $derived(imp ? imp.channels.filter((c) => channels.table.channels.some((t) => t.number === c.number)).length : 0);
</script>

{#if imp}
  <div class="overlay" role="presentation">
    <div class="dialog card" role="dialog" aria-modal="true" aria-labelledby="imp-title">
      <h2 id="imp-title">Import CHIRP CSV</h2>
      <p><b>{imp.file}</b>: {imp.channels.length} channels{#if imp.skipped}, {imp.skipped} lines skipped{/if}.</p>
      {#if imp.notes.length}
        <ul class="notes">
          {#each imp.notes as n, i (i)}<li>{n}</li>{/each}
        </ul>
      {/if}
      <label class="opt"><input type="radio" name="how" checked={!replace} onchange={() => (replace = false)} /> Merge by number: {clashes} of the table's channels replaced, the rest kept</label>
      <label class="opt"><input type="radio" name="how" checked={replace} onchange={() => (replace = true)} /> Replace every channel in the table</label>
      <p class="sub">Only the table changes. Write to the radio shows the diff before anything is sent.</p>
      <div class="actions">
        <button class="btn" onclick={() => (channels.imported = null)}>Cancel</button>
        <button class="btn primary" disabled={!imp.channels.length} onclick={() => channels.applyImport(replace)}>Import {imp.channels.length}</button>
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
    width: min(640px, 100%);
    max-height: calc(100vh - 32px);
    overflow: auto;
  }
  h2 {
    margin: 0 0 12px;
    font-size: 17px;
  }
  p {
    margin: 0 0 10px;
  }
  .notes {
    max-height: 180px;
    overflow: auto;
    margin: 0 0 12px;
    padding: 8px 12px 8px 26px;
    border: 1px solid var(--line);
    border-radius: 8px;
    color: var(--amber);
    font-size: 12px;
  }
  .opt {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-bottom: 6px;
  }
  .sub {
    color: var(--sub);
    font-size: 12px;
    margin-top: 10px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 16px;
  }
</style>
