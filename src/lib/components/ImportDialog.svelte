<script lang="ts">
  // A CHIRP CSV file read by the core, for review before it goes into the table. Three ways in: as new channels in a
  // new zone (the default when the file's numbers clash with the table's: a RepeaterBook or CHIRP export numbers from
  // 0 or 1), merged by number, or replacing every channel.
  import { channels } from "../channels.svelte";
  import { chirpNewZone, chirpZoneName, P, zoneOverCap } from "../core";

  type How = "zone" | "merge" | "replace";
  let how = $state<How>("merge");
  let zoneName = $state("");
  /** CHAN-35: zones the merge takes past 256 are split over new zones (" 2", " 3"); unticked, the import waits. */
  let split = $state(true);
  const imp = $derived(channels.imported);
  const clashes = $derived(imp ? imp.channels.filter((c) => channels.table.channels.some((t) => t.number === c.number)).length : 0);
  const nz = $derived(imp ? chirpNewZone($state.snapshot(imp.channels), $state.snapshot(channels.table), zoneName) : null);
  const byComment = $derived(imp ? imp.channels.filter((c) => c.zone !== null).length : 0);
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

  // A new file: its zone name, and the default way in.
  let seen: object | null = null;
  $effect(() => {
    if (!imp || imp === seen) return;
    seen = imp;
    zoneName = chirpZoneName(imp.file, $state.snapshot(channels.table.zones));
    const room = !chirpNewZone($state.snapshot(imp.channels), $state.snapshot(channels.table), zoneName).room;
    how = clashes && room ? "zone" : "merge";
  });

  // Merge or replace: the zones (named in the file's Comments) it would take past 256.
  const over = $derived(imp && how !== "zone" ? zoneOverCap(channels.importPreview(how === "replace")) : []);

  function apply() {
    if (how === "zone") {
      if (nz) channels.applyImportNewZone(nz);
    } else channels.applyImport(how === "replace", split);
  }
  const blocked = $derived(!imp?.channels.length || (how === "zone" && (!nz || !!nz.room || !!nz.name_error)) || (how !== "zone" && over.length > 0 && !split));
</script>

{#if imp}
  <div class="overlay" role="presentation">
    <div class="dialog card" role="dialog" aria-modal="true" aria-labelledby="imp-title">
      <h2 id="imp-title">Import CHIRP CSV</h2>
      <p><b>{imp.file}</b>: {imp.channels.length} channels{#if imp.skipped}, {imp.skipped} {imp.skipped === 1 ? "line" : "lines"} skipped{/if}.</p>
      {#if imp.notes.length}
        <ul class="notes">
          {#each imp.notes as n, i (i)}<li>{n}</li>{/each}
        </ul>
      {/if}
      <label class="opt"
        ><input type="radio" name="how" value="zone" checked={how === "zone"} disabled={!nz || !!nz.room} onchange={() => (how = "zone")} /> Add as new channels in a new zone</label
      >
      <div class="more" class:off={how !== "zone"}>
        {#if nz?.room}
          <p class="why">Not possible: {nz.room}.</p>
        {:else if nz}
          <label class="zn">New zone name <input bind:value={zoneName} maxlength="16" aria-label="New zone name" disabled={how !== "zone"} /></label>
          {#if nz.name_error}
            <p class="why">{nz.name_error[0].toUpperCase() + nz.name_error.slice(1)}.</p>
          {:else if nz.zones.length > 1}
            <p class="plan">
              Add {plural(nz.channels.length, "channel")} as {nz.numbers} in {nz.zones.length} new zones, '{nz.zones[0].name}' to '{nz.zones[nz.zones.length - 1].name}' (a zone
              holds {P.limits.zoneCap}).
            </p>
          {:else}
            <p class="plan">Add {plural(nz.channels.length, "channel")} as {nz.numbers} in a new zone '{zoneName.trim()}'.</p>
          {/if}
          <p class="sub">
            The file's order is kept, at free numbers (after the table's highest when they fit). A Comment naming a zone is ignored: every channel goes in
            the new zone{#if byComment} ({byComment} named one){/if}.
          </p>
        {/if}
      </div>
      <label class="opt"><input type="radio" name="how" value="merge" checked={how === "merge"} onchange={() => (how = "merge")} /> Merge by number: {clashes} of the table's channels replaced, the rest kept</label>
      <label class="opt"><input type="radio" name="how" value="replace" checked={how === "replace"} onchange={() => (how = "replace")} /> Replace every channel in the table</label>
      {#if over.length}
        <div class="more" role="alert">
          {#each over as o (o.number)}
            <p class="why">Zone {o.number} {o.name} would hold {o.count} channels: a zone holds {P.limits.zoneCap} at most.</p>
          {/each}
          <label class="opt"><input type="checkbox" bind:checked={split} aria-label="Split long zones" /> Split {over.length === 1 ? "it" : "them"} over new zones ({over[0].name} 2, {over[0].name} 3 …)</label>
        </div>
      {/if}
      <p class="sub">Only the table changes. Write to the radio shows the diff before anything is sent.</p>
      <div class="actions">
        <button class="btn" onclick={() => (channels.imported = null)}>Cancel</button>
        <button class="btn primary" disabled={blocked} onclick={apply}>Import {imp.channels.length}</button>
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
  .more {
    margin: 0 0 10px 26px;
  }
  .more.off {
    opacity: 0.6;
  }
  .more p {
    margin: 4px 0;
  }
  .zn {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .zn input {
    font: inherit;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 3px 6px;
    width: 18ch;
  }
  .plan {
    font-weight: 600;
  }
  .why {
    color: var(--amber);
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
