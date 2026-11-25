<script lang="ts">
  // A settings write's steps: the backup read (kept in memory, LINK-21.2), the diff with ferrite's own dry run, the write on
  // confirm, and the read back. For Radio Settings, and for APRS settings (`store`, `what`).
  import { settings, type SettingsWriteStep } from "../settings.svelte";
  import KeptBackup from "./KeptBackup.svelte";

  type Store = { write: SettingsWriteStep | null; closeWrite(): void; commitWrite(): Promise<void> };
  let { store = settings as Store, what = "settings" }: { store?: Store; what?: string } = $props();
  const w = $derived(store.write);
  /** The change list is folded under its count (most writes don't need reading row by row). */
  let listOpen = $state(false);
  // Every write starts folded.
  $effect(() => {
    if (!w) listOpen = false;
  });
</script>

{#if w}
  <div class="overlay" role="presentation">
    <div class="dialog card" role="dialog" aria-modal="true" aria-labelledby="swrite-title">
      <h2 id="swrite-title">Write {what} to the radio</h2>

      {#if w.step === "backup"}
        <p>Reading the radio's {what} for a backup first…</p>
      {:else if w.step === "review"}
        <KeptBackup kept={w.kept} {what} close={() => store.closeWrite()} />
        {#if w.radio.length}
          <!-- LINK-21.1: what changed on the radio since the read, and which of those this write replaces. -->
          <div class="drift" data-k="drift">
            <p class="note">
              {#if w.whole}
                Changed on the radio since the read. The loaded file is written whole: it replaces what it sets differently.
              {:else}
                Changed on the radio since the read. The write keeps these and puts only your edits on top{w.overridden.length ? "; where you edited the same setting, your edit wins" : ""}.
              {/if}
            </p>
            <ul>
              {#each w.radio as c (c.id)}
                {@const o = w.overridden.find((x) => x.id === c.id)}
                <li>
                  <span class="nm">{c.path ? `${c.path} ` : ""}{c.name}</span>
                  <span class="f"><s>{c.from || "–"}</s> → <b>{c.to || "–"}</b></span>
                  {#if o}<span class="over" data-k="overridden">{w.whole ? "replaced" : "your edit wins"}: <b>{o.to || "–"}</b></span>{:else}<span class="kept">kept</span>{/if}
                </li>
              {/each}
            </ul>
          </div>
        {/if}
        {#if w.plan.problems.length}
          <div class="problems">
            <b>The radio would refuse or keep {w.plan.problems.length === 1 ? "this" : "these"}:</b>
            <ul>{#each w.plan.problems as p, i (i)}<li>{p.error}</li>{/each}</ul>
          </div>
        {/if}
        {#if !w.plan.changes.length}
          <p>Nothing to write: the radio already holds these {what}.</p>
        {:else}
          <details class="diff" bind:open={listOpen}>
            <summary><b>{w.plan.changes.length} changed</b><span class="more">{listOpen ? "Hide the list" : "Show the list"}</span></summary>
            <h3 class="changed">Changed ({w.plan.changes.length})</h3>
            <ul>
              {#each w.plan.changes as c (c.id)}
                <li>
                  <span class="what">{c.path}</span>
                  <span class="nm">{c.name}</span>
                  <span class="f"><s>{c.from || "–"}</s> → <b>{c.to || "–"}</b></span>
                  <span class="grp">{c.group}</span>
                </li>
              {/each}
            </ul>
          </details>
          {#if w.plan.cmds.length}
            <p class="sub">
              {w.plan.cmds.length === 1 ? "One goes" : `${w.plan.cmds.length} go`} as the radio's own <code>set</code> command (no record
              carries {w.plan.cmds.length === 1 ? "it" : "them"}).
            </p>
          {/if}
        {/if}
        <div class="actions">
          <button class="btn" onclick={() => store.closeWrite()}>Cancel</button>
          <button class="btn primary" disabled={!!w.plan.problems.length || !(w.plan.ops.length || w.plan.cmds.length)} onclick={() => store.commitWrite()}>
            Write {w.plan.changes.length} {w.plan.changes.length === 1 ? "change" : "changes"}
          </button>
        </div>
      {:else if w.step === "writing"}
        <p>Writing… The radio shows its progress; BACK there cancels.</p>
      {:else}
        {#if w.error}
          <p class="err">Not written: {w.error}</p>
          <p class="sub">The editor keeps your edits; Write again shows what is left.</p>
        {:else if w.verified}
          <p class="ok">Written: {w.plan.changes.length} {w.plan.changes.length === 1 ? "change" : "changes"}. Read back: the radio holds these {what}.</p>
        {:else}
          <p class="note">Written, but the read back differs: the editor now shows what the radio holds.</p>
        {/if}
        <KeptBackup kept={w.kept} {what} written close={() => store.closeWrite()} />
        <div class="actions"><button class="btn primary" onclick={() => store.closeWrite()}>Close</button></div>
      {/if}
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
    width: min(760px, 100%);
    max-height: calc(100vh - 32px);
    overflow: auto;
    box-shadow: var(--shadow);
  }
  h2 {
    margin: 0 0 12px;
    font-size: 17px;
  }
  h3 {
    margin: 14px 0 6px;
    font-size: 13px;
  }
  h3.added {
    color: var(--green);
  }
  h3.changed {
    color: var(--amber);
  }
  h3.deleted {
    color: var(--red);
  }
  p {
    margin: 0 0 10px;
  }
  .sub {
    color: var(--sub);
    font-size: 12px;
  }
  .ok {
    color: var(--green);
  }
  .note {
    color: var(--amber);
  }
  .err {
    color: var(--red);
  }
  .problems {
    border: 1px solid var(--red);
    border-radius: 8px;
    padding: 10px 12px;
    margin-bottom: 10px;
    color: var(--red);
  }
  .drift ul {
    margin: -4px 0 10px;
    padding-left: 0;
    list-style: none;
    font-size: 13px;
  }
  .drift li {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 10px;
    padding: 3px 0;
  }
  .over {
    color: var(--amber);
  }
  .kept {
    color: var(--sub);
  }
  .problems ul,
  .diff ul {
    margin: 6px 0 0;
    padding-left: 0;
    list-style: none;
  }
  .diff li {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 10px;
    padding: 5px 0;
    border-bottom: 1px solid var(--line);
    font-size: 13px;
  }
  .what {
    color: var(--sub);
    min-width: 64px;
  }
  .nm {
    font-weight: 500;
    min-width: 140px;
  }
  .fields {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 12px;
    flex-basis: 100%;
    padding-left: 74px;
  }
  .f i {
    color: var(--sub);
    font-style: normal;
  }
  .f s {
    color: var(--dim);
  }
  .bar {
    height: 6px;
    border-radius: 3px;
    background: var(--raised);
    overflow: hidden;
    margin-bottom: 6px;
  }
  .bar div {
    height: 100%;
    background: var(--blue);
    transition: width 0.1s;
  }
  .grp {
    color: var(--dim);
    font-size: 11px;
    margin-left: auto;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 16px;
  }
  .diff > summary {
    cursor: pointer;
    font-size: 13px;
    color: var(--sub);
    padding: 4px 0;
  }
  .diff > summary b {
    color: var(--text);
  }
  .diff > summary .more {
    margin-left: 6px;
    color: var(--blue);
    text-decoration: underline;
  }
</style>
