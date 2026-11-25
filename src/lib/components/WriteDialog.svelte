<script lang="ts">
  // The write's steps: the backup read (kept in memory, LINK-21.2), the diff with ferrite's own checks, the write on confirm,
  // and the read back.
  import { channels, writeCount } from "../channels.svelte";
  import type { Change } from "../core";
  import KeptBackup from "./KeptBackup.svelte";

  const w = $derived(channels.write);
  const plan = $derived(w && w.step !== "backup" ? w.plan : null);
  /** The range presets' part rides along: their changes and problems shown with the channels'. */
  const pre = $derived(w && w.step !== "backup" ? w.presets : null);
  const problems = $derived([...(plan?.problems ?? []), ...(pre?.problems ?? [])]);
  const changes = $derived([...(plan?.changes ?? []), ...(pre?.changes ?? [])]);
  const groups = $derived.by(() => {
    const c = changes;
    const of = (k: Change["kind"]) => c.filter((x) => x.kind === k);
    return [
      { kind: "added", title: "Added", items: of("added") },
      { kind: "changed", title: "Changed", items: of("changed") },
      { kind: "deleted", title: "Deleted", items: of("deleted") },
    ].filter((g) => g.items.length);
  });
  const names: Record<string, string> = {
    rx: "RX",
    tx: "TX",
    rx_tone: "RX tone",
    tx_tone: "TX tone",
    rx_only: "RX only",
    end_tone: "end tone",
    scan_all: "scan all",
    by_distance: "by distance",
    pri1: "priority 1",
    pri2: "priority 2",
    keep: "other flags",
    low: "start",
    high: "end",
    skipped: "skipped",
  };
  /** The change list's one-line summary (the list itself is folded: most writes don't need reading row by row). */
  const summary = $derived(
    [...groups.map((g) => `${g.items.length} ${g.title.toLowerCase()}`), ...(w && w.step !== "backup" && w.home ? ["home channel"] : [])].join(" · "),
  );
  let listOpen = $state(false);
  // Every write starts folded.
  $effect(() => {
    if (!w) listOpen = false;
  });
  const whatName = (c: Change) => (c.what === "zone" ? "Zone" : c.what === "preset" ? "Preset" : "Ch");
  /** LINK-53: the radio can't store positions: the write leaves them out and says so once. */
  const canGo = $derived(!!w && w.step === "review" && !problems.length && writeCount(w) > 0);
</script>

{#if w}
  <div class="overlay" role="presentation">
    <div class="dialog card" role="dialog" aria-modal="true" aria-labelledby="write-title">
      <h2 id="write-title">Write to the radio</h2>

      {#if w.step === "backup"}
        <p>Reading the radio for a backup first…</p>
        {#if channels.progress}
          <div class="bar"><div style:width={`${(100 * channels.progress.done) / Math.max(1, channels.progress.total)}%`}></div></div>
          <p class="sub">{channels.progress.label}</p>
        {/if}
      {:else if w.step === "review"}
        <KeptBackup kept={w.kept} what="channels and zones" close={() => channels.closeWrite()} />
        {#if w.drifted}
          <p class="note">The radio changed since the table was read: this diff is against the radio as it is now.</p>
        {/if}
        {#if problems.length}
          <div class="problems">
            <b>The radio would refuse {problems.length === 1 ? "this" : "these"}; fix {problems.length === 1 ? "it" : "them"} first:</b>
            <ul>
              {#each problems as p, i (i)}<li>{p.what === "set" ? "" : `${p.what === "preset" ? "range preset" : p.what}${p.number ? ` ${p.number}` : "s"}: `}{p.error}</li>{/each}
            </ul>
          </div>
        {/if}
        {#if !changes.length && !w.home}
          <p>Nothing to write: the radio already holds the table.</p>
        {:else}
          <details class="diff" bind:open={listOpen}>
            <summary><b>{summary}</b><span class="more">{listOpen ? "Hide the list" : "Show the list"}</span></summary>
            {#each groups as g (g.kind)}
              <h3 class={g.kind}>{g.title} ({g.items.length})</h3>
              <ul>
                {#each g.items as c (c.what + c.number)}
                  <li>
                    <span class="what">{whatName(c)} {c.number}</span>
                    <span class="nm">{c.name || "(no name)"}</span>
                    {#if c.fields.length}
                      <span class="fields">
                        {#each c.fields as f (f.field)}
                          <span class="f"><i>{names[f.field] ?? f.field}</i> <s>{f.from || "–"}</s> → <b>{f.to || "–"}</b></span>
                        {/each}
                      </span>
                    {/if}
                  </li>
                {/each}
              </ul>
            {/each}
            {#if w.home}
              <h3 class="changed">Home channel</h3>
              <ul>
                <li class="home">
                  <span class="what">Home</span>
                  <span class="fields"><span class="f"><s>{w.home.from ?? "none"}</s> → <b>{w.home.to ?? "none"}</b></span></span>
                </li>
              </ul>
            {/if}
          </details>
        {/if}
        <div class="actions">
          <button class="btn" onclick={() => channels.closeWrite()}>Cancel</button>
          <button class="btn primary" disabled={!canGo} onclick={() => channels.commitWrite()}>
            Write {writeCount(w)} {writeCount(w) === 1 ? "change" : "changes"}
          </button>
        </div>
      {:else if w.step === "writing"}
        <p>Writing {w.done} of {writeCount(w)}… The radio shows its progress; BACK there cancels.</p>
        <div class="bar"><div style:width={`${(100 * w.done) / Math.max(1, writeCount(w))}%`}></div></div>
        {#if channels.progress}<p class="sub">{channels.progress.label}</p>{/if}
      {:else}
        {#if w.error}
          <p class="err">Stopped after {w.written} of {writeCount(w)}: {w.error}</p>
          <p class="sub">The table keeps your edits; the radio's set has been read again, so Write shows what is left.</p>
        {:else if w.verified}
          <p class="ok">
            Written: {writeCount(w)} {writeCount(w) === 1 ? "change" : "changes"}. Read back: the radio holds the table.
          </p>
        {:else}
          <p class="note">Written, but the read back differs from the table. The table keeps your edits; Write again shows what didn't reach the radio.</p>
        {/if}
        <KeptBackup kept={w.kept} what="channels and zones" written close={() => channels.closeWrite()} />
        <div class="actions"><button class="btn primary" onclick={() => channels.closeWrite()}>Close</button></div>
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
