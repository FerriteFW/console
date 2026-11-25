<script lang="ts">
  // UPD-25.2 (console#42): Ferrite's release notes under Firmware › Update, from the update feed (notes.ts): each
  // release newer than the radio's up to the one offered, newest first, the newest open. Offline (or a feed without
  // notes) a line says so; the update itself works the same.
  import { notesToShow, notesWanted, renderMarkdown, type ReleaseNote } from "../notes";

  let { notes, running, offered, byHand }: { notes: ReleaseNote[] | null | undefined; running: string; offered: string; byHand: boolean } = $props();

  const picked = $derived(notes ? notesToShow(notes, running, offered, byHand) : { show: [], before: "" });
  const missing = $derived(notes !== undefined && picked.show.length === 0 && notesWanted(running, offered, byHand));
</script>

{#if picked.show.length}
  <section class="card notes" aria-label="Release notes">
    <h2>What's new{picked.show.length > 1 ? ` since ${running.replace(/^v/i, "")}` : ` in ${picked.show[0].version}`}</h2>
    {#each picked.show as n, i (n.version)}
      <details open={i === 0 || undefined} data-k="notes-{n.version}">
        <summary>Ferrite {n.version}{n.date ? ` (${n.date})` : ""}</summary>
        <!-- renderMarkdown escapes the notes' text: only the markup it makes itself gets through -->
        <div class="md">{@html renderMarkdown(n.markdown)}</div>
      </details>
    {/each}
    {#if picked.before}<p class="sub" data-k="notes-before">Notes for releases before {picked.before} aren't shown here.</p>{/if}
  </section>
{:else if missing}
  <p class="sub missing" data-k="notes-missing">Release notes couldn't be loaded. The update works without them.</p>
{/if}

<style>
  h2 {
    margin: 0 0 10px;
    font-size: 15px;
  }
  details {
    border-top: 1px solid var(--line);
    padding: 8px 0;
  }
  summary {
    cursor: pointer;
    font-weight: 600;
  }
  .md {
    margin-top: 6px;
    line-height: 1.45;
    overflow-wrap: anywhere;
  }
  .md :global(h3),
  .md :global(h4),
  .md :global(h5) {
    margin: 12px 0 4px;
    font-size: 14px;
  }
  .md :global(p) {
    margin: 6px 0;
  }
  .md :global(ul) {
    margin: 4px 0;
    padding-left: 18px;
  }
  .md :global(li) {
    margin: 3px 0;
  }
  .md :global(code) {
    font-family: var(--mono, monospace);
    font-size: 0.92em;
  }
  .md :global(a) {
    color: var(--blue);
  }
  .sub {
    color: var(--sub);
  }
  .missing {
    margin: -6px 0 0;
    font-size: 13px;
  }
</style>
