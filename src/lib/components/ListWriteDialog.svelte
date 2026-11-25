<script lang="ts">
  // A list's write (quick messages, waypoints, DTMF memories): the backup read (kept in memory, LINK-21.2), the diff with
  // ferrite's own checks, the records on confirm, and the read back.
  import type { ListChange, ListWriteStep } from "../lists.svelte";
  import KeptBackup from "./KeptBackup.svelte";

  type Store = { write: ListWriteStep | null; noun: string; closeWrite(): void; commitWrite(): Promise<void> };
  let { store }: { store: Store } = $props();
  const w = $derived(store.write);
  const plan = $derived(w && w.step !== "backup" ? w.plan : null);
  const groups = $derived.by(() => {
    const c = plan?.changes ?? [];
    const of = (k: ListChange["kind"]) => c.filter((x) => x.kind === k);
    return [
      { kind: "added", title: "Added", items: of("added") },
      { kind: "changed", title: "Changed", items: of("changed") },
      { kind: "deleted", title: "Deleted", items: of("deleted") },
    ].filter((g) => g.items.length);
  });
  const n = $derived(plan?.changes.length ?? 0);
  /** The change list is folded under its one-line summary. */
  const summary = $derived(groups.map((g) => `${g.items.length} ${g.title.toLowerCase()}`).join(" · "));
  let listOpen = $state(false);
  // Every write starts folded.
  $effect(() => {
    if (!w) listOpen = false;
  });
  const plural = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;
</script>

{#if w}
  <div class="overlay" role="presentation">
    <div class="dialog card" role="dialog" aria-modal="true" aria-labelledby="lwrite-title">
      <h2 id="lwrite-title">Write {store.noun} to the radio</h2>

      {#if w.step === "backup"}
        <p>Reading the radio's {store.noun} for a backup first…</p>
      {:else if w.step === "review"}
        <KeptBackup kept={w.kept} what={store.noun} close={() => store.closeWrite()} />
        {#if w.drifted}
          <p class="note">The radio's {store.noun} changed since they were read: this diff is against the radio as it is now.</p>
        {/if}
        {#if w.plan.problems.length}
          <div class="problems">
            <b>The radio would refuse {w.plan.problems.length === 1 ? "this" : "these"}; fix {w.plan.problems.length === 1 ? "it" : "them"} first:</b>
            <ul>{#each w.plan.problems as p, i (i)}<li>{p}</li>{/each}</ul>
          </div>
        {/if}
        {#if !n}
          <p>Nothing to write: the radio already holds these {store.noun}.</p>
        {:else}
          <details class="diff" bind:open={listOpen}>
            <summary><b>{summary}</b><span class="more">{listOpen ? "Hide the list" : "Show the list"}</span></summary>
            {#each groups as g (g.kind)}
              <h3 class={g.kind}>{g.title} ({g.items.length})</h3>
              <ul>
                {#each g.items as c, i (i)}
                  <li>
                    <span class="what">{c.label}</span>
                    {#if c.name}<span class="nm">{c.name}</span>{/if}
                    {#if c.fields.length}
                      <span class="fields">
                        {#each c.fields as f (f.field)}
                          <span class="f"><i>{f.field}</i> {#if f.from}<s>{f.from}</s>{" → "}{/if}<b>{f.to || "–"}</b></span>
                        {/each}
                      </span>
                    {/if}
                  </li>
                {/each}
              </ul>
            {/each}
          </details>
        {/if}
        <div class="actions">
          <button class="btn" onclick={() => store.closeWrite()}>Cancel</button>
          <button class="btn primary" disabled={!!w.plan.problems.length || !w.plan.writes.length} onclick={() => store.commitWrite()}>
            Write {plural(n, "change")}
          </button>
        </div>
      {:else if w.step === "writing"}
        <p>Writing {w.done} of {w.plan.writes.length}…</p>
        <div class="bar"><div style:width={`${(100 * w.done) / Math.max(1, w.plan.writes.length)}%`}></div></div>
      {:else}
        {#if w.error}
          <p class="err">Stopped after {w.written} of {w.plan.writes.length}: {w.error}</p>
          <p class="sub">The editor keeps your edits; the radio's {store.noun} have been read again, so Write shows what is left.</p>
        {:else if w.verified}
          <p class="ok">Written: {plural(n, "change")}. Read back: the radio holds these {store.noun}.</p>
        {:else}
          <p class="note">Written, but the read back differs: the editor now shows what the radio holds.</p>
        {/if}
        <KeptBackup kept={w.kept} what={store.noun} written close={() => store.closeWrite()} />
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
    min-width: 86px;
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
    padding-left: 96px;
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
