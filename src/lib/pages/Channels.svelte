<script lang="ts">
  // Channels & Zones (NeonPlug's editor, in Ferrite's look): the radio's channels and zones read into a table (by
  // itself when the page opens on a connected radio), the core columns edited in place and every field in the side
  // panel, several rows at once from the bulk bar, and written back after a backup file and a diff. One toolbar:
  // Read, Write (with the count of changes), File (saved files, CHIRP CSV, a radio backup), Undo. Unwritten changes
  // survive a reload (channels.svelte.ts keeps them); deletes are undone from the notice or with Ctrl/Cmd+Z.
  import { SvelteSet } from "svelte/reactivity";
  import ChannelRow from "../components/ChannelRow.svelte";
  import ChannelDetails from "../components/ChannelDetails.svelte";
  import ZonesEditor from "../components/ZonesEditor.svelte";
  import WriteDialog from "../components/WriteDialog.svelte";
  import ImportDialog from "../components/ImportDialog.svelte";
  import LibraryDialog from "../components/library/LibraryDialog.svelte";
  import { library } from "../library.svelte";
  import { channels } from "../channels.svelte";
  import { radio } from "../radio.svelte";
  import { DEV_TOOLS } from "../devtools";
  import { channelChoices, loadCore, type Choices } from "../core";

  let choices = $state<Choices | null>(null);
  loadCore().then(() => (choices = channelChoices()));

  let tab = $state<"channels" | "zones">("channels");
  let zoneFilter = $state("all");
  let search = $state("");
  let chirpInput: HTMLInputElement;
  let fileInput: HTMLInputElement;
  let menuOpen = $state(false);
  /** The row in the side panel, by number. */
  let activeN = $state<number | null>(null);
  /** Rows ticked for the bulk bar, by number. */
  const selected = new SvelteSet<number>();
  let lastPick: number | null = null;
  /** The notice at the bottom (a delete, with Undo). */
  let notice = $state<{ text: string; undo: boolean } | null>(null);
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  /** An in-page question (dropping unwritten changes). */
  let ask = $state<{ text: string; yes: string; run: () => void } | null>(null);

  const connected = $derived(radio.phase === "connected");
  const busy = $derived(!!channels.progress || (!!channels.write && channels.write.step !== "review" && channels.write.step !== "done"));
  const t = $derived(channels.table);
  const dirty = $derived(channels.dirty);
  const pending = $derived(channels.pending);
  const baseNums = $derived(new Set((channels.base?.channels ?? []).map((c) => c.number)));
  const shown = $derived.by(() => {
    const q = search.trim().toLowerCase();
    return t.channels.filter((c) => {
      if (zoneFilter === "none" && c.zone !== null) return false;
      if (zoneFilter !== "all" && zoneFilter !== "none" && c.zone !== Number(zoneFilter)) return false;
      return !q || c.name.toLowerCase().includes(q) || c.rx.startsWith(q) || String(c.number) === q;
    });
  });
  const active = $derived(activeN === null ? null : (t.channels.find((c) => c.number === activeN) ?? null));
  const toneWords = $derived(choices ? ["off", ...choices.ctcss, ...choices.dcs.flatMap((d) => [`D${d}N`, `D${d}I`])] : []);
  const shownPicked = $derived(shown.filter((c) => selected.has(c.number)).length);
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  // Ticks and the panel follow the table: a row gone (deleted, a new read) drops out of both.
  $effect(() => {
    const have = new Set(t.channels.map((c) => c.number));
    for (const n of [...selected]) if (!have.has(n)) selected.delete(n);
    if (activeN !== null && !have.has(activeN)) activeN = null;
  });

  // Opening the page reads the radio when the table is empty (as Radio Settings does), once the last visit's
  // unwritten changes have been looked for.
  let autoRead = false;
  $effect(() => {
    if (connected && channels.ready && !channels.base && !t.channels.length && !t.zones.length && !busy && !radio.busy && !autoRead) {
      autoRead = true;
      void channels.read();
    }
    if (!connected) autoRead = false;
  });

  function read() {
    menuOpen = false;
    if (pending) {
      ask = { text: `Read from the radio and drop ${plural(pending, "unwritten change")}?`, yes: "Read and discard", run: () => void channels.read() };
      return;
    }
    void channels.read();
  }

  function write() {
    menuOpen = false;
    void channels.startWrite();
  }

  function discard() {
    menuOpen = false;
    const n = pending;
    channels.revert();
    say(`Discarded ${plural(n, "unwritten change")}.`, true);
  }

  function say(text: string, undo = false) {
    notice = { text, undo };
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => (notice = null), 10_000);
  }

  function undo() {
    channels.undo();
    notice = null;
  }

  async function pick(e: Event, then: (text: string, name: string) => void) {
    const el = e.currentTarget as HTMLInputElement;
    const f = el.files?.[0];
    el.value = "";
    if (f) then(await f.text(), f.name);
  }

  function choose(f: () => void) {
    menuOpen = false;
    f();
  }

  // ---- rows: ticks, the panel, deletes ----

  function tick(n: number, on: boolean, range: boolean) {
    const idx = shown.findIndex((c) => c.number === n);
    const from = lastPick === null ? -1 : shown.findIndex((c) => c.number === lastPick);
    if (range && from >= 0 && idx >= 0) {
      for (let i = Math.min(from, idx); i <= Math.max(from, idx); i++) on ? selected.add(shown[i].number) : selected.delete(shown[i].number);
    } else on ? selected.add(n) : selected.delete(n);
    lastPick = n;
  }

  function tickAll(on: boolean) {
    for (const c of shown) on ? selected.add(c.number) : selected.delete(c.number);
  }

  function remove(nums: number[]) {
    const n = channels.deleteChannels(nums);
    for (const x of nums) selected.delete(x);
    if (n) say(`Deleted ${plural(n, "channel")}.`, true);
  }

  function bulk(e: Event, apply: (v: string) => void) {
    const el = e.currentTarget as HTMLSelectElement;
    const v = el.value;
    el.value = "";
    if (v !== "") apply(v);
  }

  function addChannel() {
    menuOpen = false;
    tab = "channels";
    const n = channels.addChannel();
    zoneFilter = "all";
    search = "";
    if (n) {
      activeN = n;
      queueMicrotask(() => document.querySelector<HTMLInputElement>(`tr[data-n="${n}"] input.name`)?.focus());
    }
  }

  function keydown(e: KeyboardEvent) {
    const el = e.target as HTMLElement;
    const typing = el.closest("input:not([type=checkbox]), select, textarea, [contenteditable]");
    const dialogUp = library.open || !!channels.write || !!channels.imported || !!ask;
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z" && !typing && !dialogUp && channels.history.length) {
      e.preventDefault();
      undo();
    } else if (e.key === "Escape") {
      if (menuOpen) menuOpen = false;
      else if (ask) ask = null;
      else if (!dialogUp && activeN !== null) activeN = null;
    }
  }
</script>

<svelte:window onkeydown={keydown} onclick={(e) => menuOpen && !(e.target as HTMLElement).closest(".file") && (menuOpen = false)} />

<div class="page">
  <div class="toolbar" role="toolbar" aria-label="Channels">
    <div class="grp">
      <button class="btn" disabled={!connected || busy} onclick={read} title="Read every zone and channel from the radio">Read from radio</button>
      <button
        class="btn"
        class:primary={pending > 0}
        disabled={!connected || busy || !pending}
        onclick={write}
        title={connected ? "Backs the radio up to a file, shows what changes, then writes on your OK" : "Connect a radio to write"}
      >
        Write to radio{#if pending}&nbsp;({plural(pending, "change")}){/if}
      </button>
      <div class="file">
        <button class="btn" aria-haspopup="menu" aria-expanded={menuOpen} onclick={() => (menuOpen = !menuOpen)}>File <span aria-hidden="true">▾</span></button>
        {#if menuOpen}
          <div class="menu" role="menu" aria-label="File">
            <button role="menuitem" disabled={busy} onclick={() => choose(() => fileInput.click())}>
              <b>Open…</b><span>A saved file (.json) into the table; Write then restores it</span>
            </button>
            <button role="menuitem" disabled={busy || (!t.channels.length && !t.zones.length)} onclick={() => choose(() => channels.saveTable())}>
              <b>Save as…</b><span>The table, unwritten changes too, as a file</span>
            </button>
            <hr />
            <button role="menuitem" disabled={busy} onclick={() => choose(() => chirpInput.click())}>
              <b>Import CHIRP / RepeaterBook…</b><span>A CHIRP CSV file: new zone, merge or replace</span>
            </button>
            <button role="menuitem" disabled={busy || !t.channels.length} onclick={() => choose(() => channels.exportChirp())}>
              <b>Export CHIRP…</b><span>The table as a CHIRP CSV file</span>
            </button>
            <hr />
            <button role="menuitem" disabled={!connected || busy} onclick={() => choose(() => void channels.backupOnly())}>
              <b>Back up radio…</b><span>A fresh read of the radio to a file; the table is left alone</span>
            </button>
            <button role="menuitem" disabled={busy || !pending} onclick={discard}>
              <b>Discard unwritten changes</b><span>The table back as it was read</span>
            </button>
          </div>
        {/if}
      </div>
      <button class="btn quiet" disabled={!channels.history.length || busy} onclick={undo} title="Undo the last edit (Ctrl+Z, ⌘Z on a Mac)">↶ Undo</button>
    </div>
    {#if tab === "channels" && t.channels.length}
      <div class="grp find">
        <select bind:value={zoneFilter} aria-label="Show zone">
          <option value="all">All zones</option>
          <option value="none">No zone</option>
          {#each t.zones as z (z.number)}<option value={String(z.number - 1)}>{z.number} {z.name}</option>{/each}
        </select>
        <input class="search" type="search" placeholder="Find: name, MHz or number" aria-label="Find a channel" bind:value={search} />
      </div>
    {/if}
  </div>
  <input bind:this={chirpInput} type="file" accept=".csv,text/csv" hidden onchange={(e) => pick(e, (s, n) => channels.importChirp(s, n))} />
  <input bind:this={fileInput} type="file" accept=".json,application/json" hidden onchange={(e) => pick(e, (s, n) => channels.loadFile(s, n))} />

  {#if channels.restored}
    <div class="restored" aria-live="polite">
      <span>Restored {plural(channels.restored, "unwritten change")} from your last visit.</span>
      <button class="btn primary" disabled={!connected || busy} onclick={write} title={connected ? "" : "Connect a radio to write"}>Write</button>
      <button class="btn" onclick={discard}>Discard</button>
    </div>
  {/if}

  <div class="status">
    {#if channels.progress}
      <div class="bar" class:busy={!channels.progress.total}>
        <div style:width={channels.progress.total ? `${(100 * channels.progress.done) / channels.progress.total}%` : undefined}></div>
      </div>
      <span>{channels.progress.label}</span>
    {:else if channels.source}
      <span>{channels.source}</span>
      <span class="sub">· {plural(t.channels.length, "channel")}, {plural(t.zones.length, "zone")}</span>
      {#if dirty.any}
        <span class="dirty"
          >· not written: {plural(dirty.changed.size, "channel")} changed or added{#if dirty.deleted}, {dirty.deleted} deleted{/if}{#if dirty.zones.size || dirty.zonesDeleted}, {plural(dirty.zones.size + dirty.zonesDeleted, "zone")}{/if}{#if dirty.home}, the home channel{/if}</span
        >
      {/if}
    {/if}
  </div>
  {#if channels.error}<div class="banner">{channels.error}</div>{/if}
  {#if channels.notes.length}
    <details class="notes" open={channels.notes.length < 4}>
      <summary>{plural(channels.notes.length, "note")}</summary>
      <ul>{#each channels.notes as n, i (i)}<li>{n}</li>{/each}</ul>
    </details>
  {/if}

  <div class="tabrow">
    <div class="tabs" role="tablist">
      <button role="tab" aria-selected={tab === "channels"} class:on={tab === "channels"} onclick={() => (tab = "channels")}>Channels <span>{t.channels.length}</span></button>
      <button role="tab" aria-selected={tab === "zones"} class:on={tab === "zones"} onclick={() => (tab = "zones")}>Zones <span>{t.zones.length}</span></button>
    </div>
    <div class="grp adds">
      {#if tab === "channels"}
        <button class="btn" disabled={busy || t.channels.length >= 1000} onclick={addChannel}>+ Add channel</button>
        <button class="btn" disabled={busy || t.channels.length >= 1000} onclick={() => library.show()} title="Fixed sets, airports and Canadian licensed sites near a place">
          Add from library…
        </button>
      {/if}
    </div>
  </div>

  {#if choices}
    {#if tab === "channels"}
      <datalist id="tone-words">{#each toneWords as w (w)}<option value={w}></option>{/each}</datalist>
      {#if !t.channels.length}
        <div class="empty-state card">
          {#if channels.progress}
            <p>Reading the radio's channels…</p>
          {:else}
            <h2>No channels in the table yet</h2>
            <p class="sub">
              {#if connected}Read them from the radio, or start from a file or the library.{:else}Connect a radio by cable or Bluetooth{DEV_TOOLS
                  ? " (or the demo radio)"
                  : ""} to read its channels. Files and the library work without one.{/if}
            </p>
            <div class="actions">
              {#if connected}<button class="btn primary" disabled={busy} onclick={read}>Read from radio</button>{/if}
              <button class="btn" class:primary={!connected} disabled={busy} onclick={() => chirpInput.click()}>Import a CHIRP file</button>
              <button class="btn" disabled={busy} onclick={() => library.show()}>Add from library…</button>
              <button class="btn" disabled={busy} onclick={() => fileInput.click()}>Open a saved file</button>
            </div>
          {/if}
        </div>
      {:else}
        {#if selected.size}
          <div class="bulk" role="region" aria-label="Selected channels">
            <b>{selected.size} selected</b>
            <select aria-label="Set power" onchange={(e) => bulk(e, (v) => channels.setMany(selected, { power: v }))}>
              <option value="">Power…</option>
              {#each choices.powers as p (p)}<option value={p}>{p}</option>{/each}
            </select>
            <select aria-label="Set zone" onchange={(e) => bulk(e, (v) => channels.setMany(selected, { zone: v === "none" ? null : Number(v) }))}>
              <option value="">Zone…</option>
              <option value="none">No zone</option>
              {#each t.zones as z (z.number)}<option value={String(z.number - 1)}>{z.number} {z.name}</option>{/each}
            </select>
            <select aria-label="Set scan skip" onchange={(e) => bulk(e, (v) => channels.setMany(selected, { skip: v === "on" }))}>
              <option value="">Skip…</option>
              <option value="on">Skip in scans</option>
              <option value="off">Scan them</option>
            </select>
            <select aria-label="Set mode" onchange={(e) => bulk(e, (v) => channels.setMany(selected, { mode: v }))}>
              <option value="">Mode…</option>
              {#each choices.modes as m (m)}<option value={m}>{m}</option>{/each}
            </select>
            <span class="spacer"></span>
            <button class="btn quiet" onclick={() => selected.clear()}>Clear</button>
            <button class="btn danger" onclick={() => remove([...selected])}>Delete {selected.size}</button>
          </div>
        {/if}
        <div class="work" class:with-panel={!!active}>
          <div class="scroll">
            <table class="grid">
              <thead>
                <tr>
                  <th class="sticky pick">
                    <input
                      type="checkbox"
                      aria-label="Select every channel shown"
                      checked={shown.length > 0 && shownPicked === shown.length}
                      indeterminate={shownPicked > 0 && shownPicked < shown.length}
                      onchange={(e) => tickAll(e.currentTarget.checked)}
                    />
                  </th>
                  <th class="sticky2">#</th><th>Name</th><th>RX MHz</th><th>Duplex · offset</th><th title="TX tone, RX tone">Tones TX · RX</th>
                  <th>Power</th><th>Zone</th><th title="Scan skip">Skip</th><th></th>
                </tr>
              </thead>
              <tbody>
                {#each shown as c (c.number)}
                  <ChannelRow
                    {c}
                    zones={t.zones}
                    {choices}
                    state={!baseNums.has(c.number) && channels.base ? "added" : dirty.changed.has(c.number) && channels.base ? "changed" : "same"}
                    selected={selected.has(c.number)}
                    active={activeN === c.number}
                    onselect={(on, range) => tick(c.number, on, range)}
                    onopen={() => (activeN = c.number)}
                  />
                {:else}
                  <tr><td colspan="10" class="empty">No channel matches.</td></tr>
                {/each}
              </tbody>
            </table>
          </div>
          {#if active}
            <button class="backdrop" aria-label="Close the channel panel" tabindex="-1" onclick={() => (activeN = null)}></button>
            <div class="panel">
              <ChannelDetails
                c={active}
                zones={t.zones}
                {choices}
                onclose={() => (activeN = null)}
                ondelete={() => remove([active.number])}
                onmoved={(to) => (activeN = to)}
              />
            </div>
          {/if}
        </div>
      {/if}
    {:else}
      <ZonesEditor {choices} onsay={say} />
    {/if}
  {/if}
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
    <div class="dialog card" role="dialog" aria-modal="true" aria-labelledby="ask-title">
      <h2 id="ask-title">{ask.text}</h2>
      <p class="sub">They aren't on the radio yet. Write them first, or save the table to a file, to keep them.</p>
      <div class="actions">
        <button class="btn" onclick={() => (ask = null)}>Cancel</button>
        <button
          class="btn primary"
          onclick={() => {
            const run = ask!.run;
            ask = null;
            run();
          }}>{ask.yes}</button
        >
      </div>
    </div>
  </div>
{/if}

<WriteDialog />
<ImportDialog />
<LibraryDialog />

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
  .sub {
    color: var(--sub);
  }
  .dirty {
    color: var(--amber);
  }
  .bar {
    width: 200px;
    max-width: 100%;
    height: 6px;
    border-radius: 3px;
    background: var(--raised);
    overflow: hidden;
  }
  .bar div {
    height: 100%;
    background: var(--blue);
  }
  /* Indeterminate: a block sliding across while how much is to come isn't known. */
  .bar.busy div {
    width: 30%;
    animation: slide 1.2s ease-in-out infinite alternate;
  }
  @keyframes slide {
    from {
      margin-left: 0;
    }
    to {
      margin-left: 70%;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .bar.busy div {
      animation: none;
      width: 100%;
      opacity: 0.4;
    }
  }
  .banner {
    padding: 8px 12px;
    border: 1px solid var(--red);
    border-radius: 8px;
    color: var(--red);
  }
  .notes {
    font-size: 12px;
    color: var(--amber);
  }
  .notes ul {
    margin: 4px 0 0;
    padding-left: 20px;
  }
  .tabrow {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 8px 12px;
    border-bottom: 1px solid var(--line);
  }
  .tabrow .adds {
    margin-left: auto;
    padding-bottom: 6px;
  }
  .tabs {
    display: flex;
    gap: 4px;
  }
  .tabs button {
    margin-bottom: -1px;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    padding: 8px 14px;
    cursor: pointer;
    color: var(--sub);
  }
  .tabs button.on {
    color: var(--text);
    border-bottom-color: var(--blue);
    font-weight: 700;
  }
  .tabs span {
    color: var(--sub);
    font-weight: 400;
    margin-left: 4px;
  }
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 8px;
    padding: 36px 16px;
  }
  .empty-state h2 {
    margin: 0;
    font-size: 16px;
  }
  .empty-state p {
    margin: 0;
    max-width: 52ch;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
    margin-top: 8px;
  }
  .bulk {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    padding: 6px 10px;
    border: 1px solid var(--blue);
    border-radius: 8px;
    background: var(--focus);
    font-size: 13px;
  }
  .bulk select,
  .find select,
  .search {
    height: 32px;
    padding: 0 8px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--bg);
    color: var(--text);
    font: inherit;
    font-size: 13px;
    min-width: 0;
  }
  .btn.danger {
    color: var(--red);
  }
  .btn.danger:hover {
    border-color: var(--red);
  }
  .spacer {
    flex: 1;
  }
  .search {
    width: 240px;
  }
  .work {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
    align-items: start;
  }
  .work.with-panel {
    grid-template-columns: minmax(0, 1fr) 340px;
  }
  .panel {
    position: sticky;
    top: 64px;
    max-height: calc(100vh - 80px);
    overflow: auto;
  }
  .backdrop {
    display: none;
  }
  .scroll {
    overflow: auto;
    max-width: 100%;
    max-height: calc(100vh - 300px);
    border: 1px solid var(--line);
    border-radius: 8px;
  }
  .grid {
    border-collapse: separate;
    border-spacing: 0;
    font-size: 13px;
    width: max-content;
    min-width: 100%;
  }
  .grid :global(th) {
    position: sticky;
    top: 0;
    z-index: 2;
    background: var(--surface);
    color: var(--sub);
    font-weight: 500;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    text-align: left;
    padding: 7px 6px;
    border-bottom: 1px solid var(--line);
    white-space: nowrap;
  }
  .grid :global(td) {
    padding: 2px 4px;
    border-bottom: 1px solid var(--line);
    background: var(--bg);
    white-space: nowrap;
  }
  .grid :global(tbody tr) {
    cursor: default;
  }
  .grid :global(th.sticky),
  .grid :global(td.sticky) {
    position: sticky;
    left: 0;
    z-index: 1;
    width: 34px;
    min-width: 34px;
    text-align: center;
  }
  .grid :global(th.sticky2),
  .grid :global(td.sticky2) {
    position: sticky;
    left: 34px;
    z-index: 1;
  }
  .grid :global(th.sticky),
  .grid :global(th.sticky2) {
    z-index: 3;
  }
  .grid :global(td.sticky2) {
    width: 52px;
    min-width: 52px;
  }
  .grid :global(button.open) {
    width: 100%;
    padding: 3px 6px;
    border: 1px solid transparent;
    border-radius: 5px;
    background: none;
    color: var(--sub);
    text-align: left;
    cursor: pointer;
    font-variant-numeric: tabular-nums;
  }
  .grid :global(button.open:hover) {
    border-color: var(--line);
    color: var(--text);
  }
  .grid :global(tr.changed td) {
    background: color-mix(in srgb, var(--amber) 9%, var(--bg));
  }
  .grid :global(tr.added td) {
    background: color-mix(in srgb, var(--green) 9%, var(--bg));
  }
  .grid :global(tr.sel td) {
    background: color-mix(in srgb, var(--blue) 10%, var(--bg));
  }
  .grid :global(tr.active td) {
    background: color-mix(in srgb, var(--blue) 18%, var(--bg));
  }
  .grid :global(tr.changed td:first-child) {
    box-shadow: inset 3px 0 0 var(--amber);
  }
  .grid :global(tr.added td:first-child) {
    box-shadow: inset 3px 0 0 var(--green);
  }
  .grid :global(tr.bad td:first-child) {
    box-shadow: inset 3px 0 0 var(--red);
  }
  .grid :global(tr.problem-row td) {
    color: var(--red);
    font-size: 12px;
    padding: 2px 8px 5px;
  }
  .grid :global(.sticky-note) {
    position: sticky;
    left: 8px;
  }
  .grid :global(input:not([type])),
  .grid :global(select) {
    font: inherit;
    color: var(--text);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 5px;
    padding: 3px 5px;
  }
  .grid :global(input:not([type]):hover),
  .grid :global(select:hover) {
    border-color: var(--line);
  }
  .grid :global(input:not([type]):focus),
  .grid :global(select:focus) {
    border-color: var(--blue);
    background: var(--focus);
    outline: none;
  }
  .grid :global(select option) {
    background: var(--surface);
  }
  .grid :global(input:disabled) {
    opacity: 0.4;
  }
  .grid :global(input.name) {
    width: 150px;
  }
  .grid :global(input.freq) {
    width: 92px;
    font-family: "JetBrains Mono", monospace;
  }
  .grid :global(input.tone) {
    width: 76px;
  }
  .grid :global(input.small) {
    width: 60px;
  }
  .grid :global(select.zone) {
    max-width: 160px;
  }
  .grid :global(td.ck) {
    text-align: center;
  }
  .grid :global(td.num) {
    color: var(--sub);
  }
  .grid :global(td.act) {
    text-align: right;
    width: 30px;
  }
  .grid :global(.warn) {
    display: inline-grid;
    place-items: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--red);
    color: var(--bg);
    font-weight: 700;
    font-size: 12px;
    cursor: help;
    margin-right: 4px;
  }
  .grid :global(.del) {
    background: none;
    border: none;
    color: var(--sub);
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 5px;
  }
  .grid :global(.del:hover) {
    color: var(--red);
    background: var(--raised);
  }
  .empty {
    color: var(--sub);
    padding: 18px !important;
    text-align: center;
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
  .dialog .actions {
    justify-content: flex-end;
  }
  @media (max-width: 1180px) {
    .work.with-panel {
      grid-template-columns: minmax(0, 1fr);
    }
    .backdrop {
      display: block;
      position: fixed;
      inset: 0;
      z-index: 18;
      border: none;
      background: rgb(0 0 0 / 0.4);
    }
    .panel {
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      z-index: 19;
      width: min(380px, 100vw);
      max-height: none;
      overflow: auto;
    }
    .panel :global(.details) {
      min-height: 100%;
      border-radius: 0;
    }
  }
  @media (max-width: 860px) {
    .scroll {
      max-height: none;
    }
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
      top: calc(100% + 4px);
    }
    .search {
      flex: 1;
      width: auto;
    }
  }
</style>
