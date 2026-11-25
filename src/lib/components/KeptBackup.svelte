<script lang="ts">
  // LINK-21.2 (console#43): the write's backup, the radio as it was just before it, kept in Console's memory until it
  // closes; no file unless the owner asks. In the review step it says so and offers Save this backup…; once written,
  // Put the radio back too (loads it into the page and starts that page's write: the diff, then confirm).
  import { putBack, saveKept } from "../codeplug.svelte";
  import type { Kept } from "../prewrite";

  let { kept, what, written = false, close }: { kept: Kept; what: string; written?: boolean; close: () => void } = $props();
  let note = $state("");
  let busy = $state(false);

  async function save() {
    note = "";
    busy = true;
    try {
      note = await saveKept(kept);
    } catch (e) {
      note = `Not saved: ${(e as Error).message}`;
    } finally {
      busy = false;
    }
  }

  async function back() {
    const k = kept; // read before closing: the prop comes from the write step, gone once the dialog closes
    close();
    await putBack(k);
  }
</script>

<div class="kept" data-k="kept">
  <p class="ok">
    Backup kept in Console until it closes: the radio's {what} as read at {kept.at.toLocaleTimeString()}.
    {written ? "Put the radio back writes it again (the changes shown first)." : "Once written, you can put the radio back from it here."}
  </p>
  <div class="row">
    {#if written}<button class="btn" disabled={busy} onclick={back}>Put the radio back</button>{/if}
    <button class="btn quiet" disabled={busy} onclick={save}>Save this backup…</button>
  </div>
  {#if note}<p class="sub" data-k="kept-note" aria-live="polite">{note}</p>{/if}
</div>

<style>
  .kept {
    margin-bottom: 10px;
  }
  .ok {
    color: var(--green);
    margin: 0 0 6px;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .sub {
    color: var(--sub);
    font-size: 12px;
    margin: 6px 0 0;
  }
</style>
