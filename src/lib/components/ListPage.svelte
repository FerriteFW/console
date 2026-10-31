<script lang="ts">
  // The page around one of the owner's lists (quick messages, waypoints, DTMF memories), as Channels & Zones' is:
  // the toolbar (Read, Write with its count, File: Open…, Save as…, Back up radio…, Discard; Undo), the status line,
  // last visit's unwritten changes, the radio's firmware too old for the list, a notice with Undo, and the write's
  // dialog. The editor itself is the page's `children`.
  import type { Snippet } from "svelte";
  import ListWriteDialog from "./ListWriteDialog.svelte";
  import { radio } from "../radio.svelte";
  import { loadCore } from "../core";
  import { backUp, OPEN_ACCEPT, openFile, picked, saveCodeplug } from "../codeplug.svelte";
  import type { lists } from "../lists.svelte";

  type Store = (typeof lists)[keyof typeof lists];
  let {
    store,
    label,
    children,
    find,
    notice = $bindable(null),
  }: {
    store: Store;
    /** The toolbar's name ("Quick messages"). */
    label: string;
    children: Snippet;
    /** The toolbar's right side (a search box). */
    find?: Snippet;
    /** The notice at the bottom (an edit, with Undo): the page sets it too. */
    notice?: { text: string; undo: boolean } | null;
  } = $props();

  const connected = $derived(radio.phase === "connected");
  const busy = $derived(!!store.busy || (!!store.write && store.write.step !== "review" && store.write.step !== "done"));
  const pending = $derived(store.pending);
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  let menuOpen = $state(false);
  let ask = $state<{ text: string; yes: string; run: () => void } | null>(null);
  let fileInput: HTMLInputElement;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;

  // Opening the page reads the radio (once a connection), unless there are unwritten edits to keep.
  $effect(() => {
    if (connected && store.ready) store.ensure();
    if (!connected) store.forget();
  });
  $effect(() => {
    if (notice) {
      clearTimeout(noticeTimer);
      noticeTimer = setTimeout(() => (notice = null), 10_000);
    }
  });

  function read() {
    menuOpen = false;
    if (pending) {
      ask = { text: `Read from the radio and drop ${plural(pending, "unwritten change")}?`, yes: "Read and discard", run: () => void store.read() };
      return;
    }
    void store.read();
  }

  function discard() {
    menuOpen = false;
    const n = pending;
    store.revert();
    notice = { text: `Discarded ${plural(n, "unwritten change")}.`, undo: true };
  }

  function undo() {
    store.undo();
    notice = null;
  }

  async function open(e: Event) {
    const f = await picked(e);
    if (!f) return;
    await loadCore(); // a file picked as the page opens: the core may still be loading
    try {
      notice = { text: (await openFile(f)).notice, undo: false };
    } catch (err) {
      store.error = (err as Error).message;
    }
  }

  async function saving(run: () => Promise<string>) {
    menuOpen = false;
    store.error = "";
    try {
      const text = await run();
      if (text) notice = { text, undo: false };
    } catch (err) {
      store.error = (err as Error).message;
    }
  }

  function keydown(e: KeyboardEvent) {
    const el = e.target as HTMLElement;
    const typing = el.closest("input:not([type=checkbox]), select, textarea, [contenteditable]");
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z" && !typing && !store.write && !ask && store.history.length) {
      e.preventDefault();
      undo();
    } else if (e.key === "Escape") {
      if (menuOpen) menuOpen = false;
      else if (ask) ask = null;
    }
  }
</script>

<svelte:window onkeydown={keydown} onclick={(e) => menuOpen && !(e.target as HTMLElement).closest(".file") && (menuOpen = false)} />

<div class="page">
  <div class="toolbar" role="toolbar" aria-label={label}>
    <div class="grp">
      <button class="btn" disabled={!connected || busy || !store.supported} onclick={read} title={`Read the radio's ${store.noun}`}>Read from radio</button>
      <button
        class="btn"
        class:primary={pending > 0}
        disabled={!connected || busy || !pending || !store.supported}
        onclick={() => void store.startWrite()}
        title={connected ? "Backs the radio's list up to a file, shows what changes, then writes on your OK" : "Connect a radio to write"}
      >
        Write to radio{#if pending}&nbsp;({plural(pending, "change")}){/if}
      </button>
      <div class="file">
        <button class="btn" aria-haspopup="menu" aria-expanded={menuOpen} onclick={() => (menuOpen = !menuOpen)}>File <span aria-hidden="true">▾</span></button>
        {#if menuOpen}
          <div class="menu" role="menu" aria-label="File">
            <button role="menuitem" disabled={busy} onclick={() => ((menuOpen = false), fileInput.click())}>
              <b>Open…</b><span>A codeplug (.ferrite) or an older backup (.json); Write then puts it on the radio</span>
            </button>
            <button role="menuitem" disabled={busy} onclick={() => void saving(saveCodeplug)}>
              <b>Save as…</b><span>One codeplug (.ferrite): these {store.noun} with their unwritten changes, and everything else read or opened</span>
            </button>
            <hr />
            <button role="menuitem" disabled={!connected || busy || !store.supported} onclick={() => void saving(() => backUp(store.key))}>
              <b>Back up radio…</b><span>A fresh read of the radio's {store.noun} to a .ferrite; the editor is left alone</span>
            </button>
            <button role="menuitem" disabled={busy || !pending} onclick={discard}>
              <b>Discard unwritten changes</b><span>Back as they were read</span>
            </button>
          </div>
        {/if}
      </div>
      <button class="btn quiet" disabled={!store.history.length || busy} onclick={undo} title="Undo the last edit (Ctrl+Z, ⌘Z on a Mac)">↶ Undo</button>
    </div>
    {#if find}<div class="grp find">{@render find()}</div>{/if}
  </div>
  <input bind:this={fileInput} type="file" accept={OPEN_ACCEPT} hidden onchange={open} />

  {#if store.restored}
    <div class="restored" aria-live="polite">
      <span>Restored {plural(store.restored, "unwritten change")} from your last visit.</span>
      <button class="btn primary" disabled={!connected || busy || !store.supported} onclick={() => void store.startWrite()} title={connected ? "" : "Connect a radio to write"}
        >Write</button
      >
      <button class="btn" onclick={discard}>Discard</button>
    </div>
  {/if}

  <div class="status" aria-live="polite" data-status>
    {#if store.busy}
      <span>{store.busy}…</span>
    {:else if store.source}
      <span>{store.source}</span>
      {#if pending}<span class="dirty">· not written: {plural(pending, "change")}</span>{/if}
    {:else if connected && store.supported}
      <span>Read from radio to see its {store.noun}, or open a file.</span>
    {:else if !connected}
      <span>Connect (cable, Bluetooth or the demo radio) to read the radio's {store.noun}; files work without a radio.</span>
    {/if}
  </div>
  {#if store.oldFirmware}
    <div class="pg-banner warn" data-testid="old-firmware">
      This radio's firmware doesn't share its {store.noun} over the link: update Ferrite to read and write them here. Files still open and save.
    </div>
  {/if}
  {#if store.error}<div class="pg-banner">{store.error}</div>{/if}

  {@render children()}
</div>

{#if notice}
  <div class="toast" aria-live="polite">
    <span>{notice.text}</span>
    {#if notice.undo}<button class="btn quiet" onclick={undo}>Undo</button>{/if}
    <button class="x" aria-label="Dismiss" onclick={() => (notice = null)}>✕</button>
  </div>
{/if}

{#if ask}
  <div class="overlay" role="presentation">
    <div class="dialog card" role="dialog" aria-modal="true" aria-labelledby="lask-title">
      <h2 id="lask-title">{ask.text}</h2>
      <p class="sub">They aren't on the radio yet. Write them first, or save them to a file, to keep them.</p>
      <div class="actions">
        <button class="btn" onclick={() => (ask = null)}>Cancel</button>
        <button
          class="btn primary"
          onclick={() => {
            const a = ask;
            ask = null;
            a?.run();
          }}>{ask.yes}</button
        >
      </div>
    </div>
  </div>
{/if}

<ListWriteDialog {store} />

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
  }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 10px 22px;
    align-items: center;
    padding: 8px 10px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface);
  }
  .grp {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    min-width: 0;
  }
  .grp.find {
    margin-left: auto;
  }
  .file {
    position: relative;
  }
  .menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 15;
    width: min(340px, calc(100vw - 32px));
    display: flex;
    flex-direction: column;
    padding: 6px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--surface);
    box-shadow: var(--shadow);
  }
  .menu button {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    padding: 8px 10px;
    border: none;
    border-radius: 6px;
    background: none;
    text-align: left;
    cursor: pointer;
  }
  .menu button:hover:not(:disabled),
  .menu button:focus-visible {
    background: var(--raised);
  }
  .menu button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .menu b {
    font-weight: 600;
  }
  .menu span {
    color: var(--sub);
    font-size: 12px;
  }
  .menu hr {
    border: none;
    border-top: 1px solid var(--line);
    margin: 4px 2px;
  }
  .restored {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 12px;
    align-items: center;
    padding: 8px 12px;
    border: 1px solid var(--amber);
    border-radius: 8px;
    color: var(--amber);
  }
  .restored span {
    flex: 1;
    min-width: 200px;
  }
  .status {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    font-size: 13px;
    min-height: 20px;
  }
  .dirty {
    color: var(--amber);
  }
  .toast {
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 25;
    display: flex;
    align-items: center;
    gap: 10px;
    width: max-content;
    max-width: calc(100vw - 32px);
    padding: 8px 10px 8px 14px;
    border: 1px solid var(--blue);
    border-radius: 10px;
    background: var(--toast);
    box-shadow: var(--shadow);
    font-size: 13px;
  }
  .x {
    background: none;
    border: none;
    color: var(--sub);
    cursor: pointer;
    padding: 4px 6px;
    border-radius: 6px;
  }
  .overlay {
    position: fixed;
    inset: 0;
    background: rgb(0 0 0 / 0.55);
    display: grid;
    place-items: center;
    z-index: 30;
    padding: 16px;
  }
  .dialog {
    width: min(460px, 100%);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .dialog h2 {
    margin: 0;
    font-size: 16px;
  }
  .dialog p {
    margin: 0;
  }
  .actions {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
  }
  @media (max-width: 860px) {
    .grp.find {
      margin-left: 0;
      width: 100%;
    }
    .toolbar {
      position: relative;
    }
    .file {
      position: static;
    }
    .menu {
      left: 8px;
      right: 8px;
      width: auto;
    }
  }
</style>
