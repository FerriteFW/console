<script lang="ts">
  // Channels & Zones (NeonPlug's editor, in Ferrite's look): the radio's channels and zones read into a table (by
  // itself when the page opens on a connected radio), the core columns edited in place and every field in the side
  // panel, several rows at once from the bulk bar, and written back after a backup file and a diff. One toolbar:
  // Read, Write (with the count of changes), File (saved files, CHIRP CSV, a radio backup), Undo. Unwritten changes
  // survive a reload (channels.svelte.ts keeps them); deletes are undone from the notice or with Ctrl/Cmd+Z. The
  // radio's range presets (MENU 0 1 4) are a third tab: read and written with the channels, in the same table, since
  // they're programmed as the channels are and a band scan of one goes with the channel scans it sits beside.
  import { tick as settle } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import ChannelRow from "../components/ChannelRow.svelte";
  import ChannelDetails from "../components/ChannelDetails.svelte";
  import ZonesEditor from "../components/ZonesEditor.svelte";
  import PresetsEditor from "../components/PresetsEditor.svelte";
  import { route } from "../route.svelte";
  import WriteDialog from "../components/WriteDialog.svelte";
  import ImportDialog from "../components/ImportDialog.svelte";
  import LibraryDialog from "../components/library/LibraryDialog.svelte";
  import { library } from "../library.svelte";
  import { channels } from "../channels.svelte";
  import { backUp, backUpAll, OPEN_ACCEPT, openFile, picked, saveCodeplug } from "../codeplug.svelte";
  import { settings } from "../settings.svelte";
  import { aprsSettings } from "../aprsSettings.svelte";
  import { contacts } from "../contacts.svelte";
  import { radio } from "../radio.svelte";
  import { DEV_TOOLS } from "../devtools";
  import { channelChoices, loadCore, type Channel, type Choices } from "../core";

  /** A per-viewer preference (localStorage may be blocked: then it's just not kept). */
  function readPref(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  }
  function writePref(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* not kept */
    }
  }

  let choices = $state<Choices | null>(null);
  loadCore().then(() => (choices = channelChoices()));

  type Tab = "channels" | "zones" | "presets";
  const tabOf = (v: string | null): Tab => (v === "zones" || v === "presets" ? v : "channels");
  let tab = $state<Tab>(tabOf(route.params.get("tab")));
  // `#/channels?tab=presets` (Radio Settings' 0 1 4 row) opens that tab.
  $effect(() => {
    const want = route.params.get("tab");
    if (want) tab = tabOf(want);
  });
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
  /** An in-page question (dropping unwritten changes, a renumber); `sub` the line under it. */
  let ask = $state<{ text: string; yes: string; run: () => void; sub?: string } | null>(null);
  /** console#55: empty numbers shown as rows (kept per viewer). */
  let showEmpty = $state(readPref("ferrite.channels.showEmpty") === "1");
  $effect(() => writePref("ferrite.channels.showEmpty", showEmpty ? "1" : "0"));
  /** A row's menu (right-click, or its ⋯): the channel and where. */
  let rowMenu = $state<{ n: number; x: number; y: number } | null>(null);
  /** Move to…: the channels (in number order) and the first number typed. */
  let moveAsk = $state<{ picked: number[]; value: string } | null>(null);

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
  /** Empty numbers show only over the whole table (not a zone or a search: those rows aren't neighbours). */
  const gapsOn = $derived(showEmpty && zoneFilter === "all" && !search.trim());
  /** The table's rows: channels, and with `gapsOn` the empty numbers between them (a run of more than 5 as one row)
   *  and the one after the last. */
  type Row = { c: Channel; gap?: undefined } | { gap: [number, number]; c?: undefined };
  const rows = $derived.by((): Row[] => {
    if (!gapsOn) return shown.map((c) => ({ c }));
    const max = choices?.maxChannels ?? 4000;
    const out: Row[] = [];
    const add = (a: number, b: number) => {
      if (b - a < 5) for (let n = a; n <= b; n++) out.push({ gap: [n, n] });
      else out.push({ gap: [a, b] });
    };
    let next = 1;
    for (const c of shown) {
      if (c.number > next) add(next, c.number - 1);
      out.push({ c });
      next = c.number + 1;
    }
    if (next <= max) out.push({ gap: [next, next] });
    return out;
  });
  const active = $derived(activeN === null ? null : (t.channels.find((c) => c.number === activeN) ?? null));
  const toneWords = $derived(choices ? ["off", ...choices.ctcss, ...choices.dcs.flatMap((d) => [`D${d}N`, `D${d}I`])] : []);
  const shownPicked = $derived(shown.filter((c) => selected.has(c.number)).length);
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  /** What isn't written yet, in words: only the kinds that have changes. */
  const unwritten = $derived.by(() => {
    const d = dirty;
    const out: string[] = [];
    if (d.changed.size || d.deleted) out.push(`${plural(d.changed.size, "channel")} changed or added${d.deleted ? `, ${d.deleted} deleted` : ""}`);
    if (d.zones.size || d.zonesDeleted) out.push(plural(d.zones.size + d.zonesDeleted, "zone"));
    if (d.presets.size || d.presetsDeleted) out.push(plural(d.presets.size + d.presetsDeleted, "range preset"));
    if (d.home) out.push("the home channel");
    return out.join(", ");
  });

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
    if (!f) return;
    const text = await f.text();
    await loadCore(); // a file picked as the page opens: the core (the importers) may still be loading
    then(text, f.name);
  }

  /** Open…: a .ferrite (every part into its page) or an older backup; one notice says what was loaded. */
  async function open(e: Event) {
    const f = await picked(e);
    if (!f) return;
    await loadCore();
    try {
      say((await openFile(f)).notice);
    } catch (err) {
      channels.error = (err as Error).message;
    }
  }

  /** Save as… and Back up radio…: the notice says where it went. */
  async function saving(run: () => Promise<string>) {
    channels.error = "";
    try {
      const text = await run();
      if (text) say(text);
    } catch (err) {
      channels.error = (err as Error).message;
    }
  }

  const anything = $derived(!!(t.channels.length || t.zones.length || channels.presets.length || settings.record || aprsSettings.record || contacts.loaded || contacts.pending));

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

  /** The channel being dragged by its handle (by number). */
  let dragFrom = $state<number | null>(null);
  /** The empty-number row a drag is over (its first number). */
  let gapOver = $state<number | null>(null);
  /** ChannelRow's drag type. */
  const DRAG = "application/x-ferrite-channel";

  /** A channel moved (dragged, ↑ ↓ on its handle, or a number typed in its panel): the ticks and the panel follow
   *  their channels to their new numbers, and the notice says what moved (undoable). */
  function moved(from: number, to: number, map: Map<number, number>) {
    if (!map.size) return;
    follow(map);
    const others = [...map.keys()].filter((n) => n !== from);
    const lo = Math.min(...others);
    const hi = Math.max(...others);
    const along = !others.length ? "" : others.length === 1 ? `; channel ${lo} is now ${map.get(lo)}` : `; channels ${lo}–${hi} moved one along (now ${map.get(lo)}–${map.get(hi)})`;
    const home = channels.home === undefined ? " The home channel wasn't read: if it was one of these, set it again on the radio." : "";
    say(`Channel ${from} is now ${to}${along}. After Write, a slot on the radio that was on a moved number tunes what's there now.${home}`, true);
  }

  /** The ticks, the panel and the range-pick anchor follow their channels to their new numbers. */
  function follow(map: Map<number, number>) {
    const ticked = [...selected].map((n) => map.get(n) ?? n);
    selected.clear();
    for (const n of ticked) selected.add(n);
    if (activeN !== null) activeN = map.get(activeN) ?? activeN;
    if (lastPick !== null) lastPick = map.get(lastPick) ?? lastPick;
  }

  const SLOT_NOTE = "After Write, a slot on the radio that was on a moved number tunes what's there now.";
  const homeNote = () => (channels.home === undefined ? " The home channel wasn't read: if it was one of these, set it again on the radio." : "");
  /** "channels 4–9 moved along", for the notices: the channels in `map` other than `except`. */
  function along(map: Map<number, number>, except: Set<number>): string {
    const others = [...map.keys()].filter((n) => !except.has(n));
    if (!others.length) return "";
    if (others.length === 1) return `; channel ${others[0]} is now ${map.get(others[0])}`;
    return `; ${plural(others.length, "other channel")} moved along to make room`;
  }

  /** console#104: channels moved together to numbers from `start` (the bulk bar's Move to…, a drag of ticked rows). */
  function moveBlock(picked: number[], start: number) {
    const r = channels.moveBlock(picked, start);
    if (r.why) return say(r.why);
    if (!r.moved.size) return say(`Already at ${start}: nothing moved.`);
    follow(r.moved);
    const k = picked.filter((n) => r.moved.has(n) || t.channels.some((c) => c.number === n)).length;
    const pickedSet = new Set(picked);
    say(`${plural(k, "channel")} now ${k === 1 ? start : `${start}–${start + k - 1}`}${along(r.moved, pickedSet)}. ${SLOT_NOTE}${homeNote()}`, true);
  }

  /** console#55, #104: a new channel at `at`, in zone `zone` when it has room; the ones from there move along as far
   *  as a gap. The panel opens on it. */
  function insertAt(at: number, zone: number | null) {
    rowMenu = null;
    const r = channels.insertAt(at, zone);
    if (r.why) return say(r.why);
    if (r.added === null) return;
    follow(r.moved);
    activeN = r.added;
    say(`Channel ${r.added} added${along(r.moved, new Set())}.${r.moved.size ? ` ${SLOT_NOTE}${homeNote()}` : ""}`, true);
    void settle().then(() => document.querySelector<HTMLInputElement>(`tr[data-n="${r.added}"] input.name`)?.focus());
  }

  /** console#104: Renumber…: what it changes, asked first. */
  function renumberAsk() {
    menuOpen = false;
    const a = channels.renumberPreview();
    const n = t.channels.length;
    if (!a.moved.length) return say(`The channels are already numbered 1–${n}: nothing to renumber.`);
    const lo = Math.min(...a.moved.map((m) => m.from));
    ask = {
      text: `Renumber ${plural(n, "channel")} as 1–${n}?`,
      sub:
        `${plural(a.moved.length, "channel")} from ${lo} on change number, keeping their order; the gaps close. ` +
        `Zones, priority channels and the home channel follow their channels. Write then writes each moved channel at its new number. ${SLOT_NOTE}`,
      yes: "Renumber",
      run: () => {
        const map = channels.renumber();
        follow(map);
        say(`Renumbered: ${plural(map.size, "channel")} changed number, now 1–${n}.${homeNote()}`, true);
      },
    };
  }

  /** The Move to… dialog's preview: where the channels go, and how many others move along; or why not. */
  const movePreview = $derived.by(() => {
    if (!moveAsk) return "";
    const start = Number(moveAsk.value);
    const k = moveAsk.picked.length;
    if (!moveAsk.value.trim() || !Number.isInteger(start)) return `A number, 1 to ${choices?.maxChannels ?? 4000}.`;
    const r = channels.moveBlockPreview(moveAsk.picked, start);
    if (r.why) return r.why;
    const others = r.moved.filter((m) => !moveAsk!.picked.includes(m.from)).length;
    if (!r.moved.length) return "They're there already.";
    return `They become ${k === 1 ? start : `${start}–${start + k - 1}`}, in their order${others ? `; ${plural(others, "other channel")} move${others === 1 ? "s" : ""} along to make room` : "; nothing else moves"}.`;
  });

  /** The dragged channel dropped on channel `to` (or on an empty number, `gap`): it takes that number. Dragging a
   *  ticked row moves every ticked channel with it (console#104): from `to` up the table, ending at `to` down it. */
  function dropOn(to: number, gap = false) {
    const from = dragFrom;
    dragFrom = null;
    if (from === null || from === to) return;
    if (selected.has(from) && selected.size > 1) {
      const picked = [...selected].sort((a, b) => a - b);
      const start = gap || to < from ? to : Math.max(1, to - picked.length + 1);
      return moveBlock(picked, start);
    }
    const r = channels.move(from, to);
    if (r.why) say(r.why);
    else moved(from, to, r.moved);
  }

  /** ↑ ↓ on a handle: the channel takes the number of the one above or below it as shown, the handle keeps focus. */
  async function step(n: number, dir: -1 | 1) {
    const i = shown.findIndex((c) => c.number === n);
    const next = shown[i + dir];
    if (i < 0 || !next) return;
    const to = next.number; // kept: the move renumbers `next` itself
    const r = channels.move(n, to);
    if (r.why) return say(r.why);
    moved(n, to, r.moved);
    // The rows are keyed by number, so the one that had focus may now show another channel: focus the handle at the
    // new number once the table has redrawn.
    await settle();
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`tr[data-n="${to}"] button.grip`)?.focus());
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
    const dialogUp = library.open || !!channels.write || !!channels.imported || !!ask || !!moveAsk;
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z" && !typing && !dialogUp && channels.history.length) {
      e.preventDefault();
      undo();
    } else if (e.key === "Escape") {
      if (menuOpen) menuOpen = false;
      else if (rowMenu) rowMenu = null;
      else if (moveAsk) moveAsk = null;
      else if (ask) ask = null;
      else if (!dialogUp && activeN !== null) activeN = null;
    }
  }
</script>

<svelte:window
  onkeydown={keydown}
  onclick={(e) => {
    const el = e.target as HTMLElement;
    if (menuOpen && !el.closest(".file")) menuOpen = false;
    if (rowMenu && !el.closest(".rowmenu, button.more")) rowMenu = null;
  }}
  onscroll={() => (rowMenu = null)}
/>

<div class="page">
  <div class="toolbar" role="toolbar" aria-label="Channels">
    <div class="grp">
      <button class="btn" disabled={!connected || busy} onclick={read} title="Read every zone, channel and range preset from the radio">Read from radio</button>
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
              <b>Open…</b><span>A codeplug (.ferrite) or an older backup (.json); Write then puts it on the radio</span>
            </button>
            <button role="menuitem" disabled={busy || !anything} onclick={() => choose(() => void saving(saveCodeplug))}>
              <b>Save as…</b><span>One codeplug (.ferrite): the table with its unwritten changes, and the settings, APRS settings and contacts read or opened</span>
            </button>
            <hr />
            <button role="menuitem" disabled={busy} onclick={() => choose(() => chirpInput.click())}>
              <b>Import CHIRP / RepeaterBook…</b><span>A CHIRP CSV file (or a stock channel list): new zone, merge or replace</span>
            </button>
            <button role="menuitem" disabled={busy || !t.channels.length} onclick={() => choose(() => channels.exportChirp())}>
              <b>Export CHIRP…</b><span>The table as a CHIRP CSV file</span>
            </button>
            <hr />
            <button role="menuitem" disabled={!connected || busy} onclick={() => choose(() => void saving(() => backUp("channels")))}>
              <b>Back up radio…</b><span>A fresh read of the radio's channels to a .ferrite; the table is left alone</span>
            </button>
            <button role="menuitem" disabled={!connected || busy} onclick={() => choose(() => void saving(backUpAll))}>
              <b>Back up everything…</b><span>A fresh read of channels, settings, APRS settings and lists to one .ferrite</span>
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
        <label class="gaps" title={zoneFilter === "all" && !search.trim() ? "Show the free numbers between channels as empty rows: drop a channel there, or add one" : "Empty numbers show with All zones and no search"}>
          <input type="checkbox" bind:checked={showEmpty} /> Show empty numbers
        </label>
      </div>
    {/if}
  </div>
  <input bind:this={chirpInput} type="file" accept=".csv,text/csv" hidden onchange={(e) => pick(e, (s, n) => channels.importChirp(s, n))} />
  <input bind:this={fileInput} type="file" accept={OPEN_ACCEPT} hidden onchange={open} />

  {#if channels.restored}
    <div class="restored" aria-live="polite">
      <span>Restored {plural(channels.restored, "unwritten change")} from your last visit.</span>
      <button class="btn primary" disabled={!connected || busy} onclick={write} title={connected ? "" : "Connect a radio to write"}>Write</button>
      <button class="btn" onclick={discard}>Discard</button>
    </div>
  {/if}

  <div class="status">
    {#if channels.progress}
      <div
        class="bar"
        class:busy={!channels.progress.total}
        role="progressbar"
        aria-label={channels.progress.label}
        aria-valuemin={0}
        aria-valuemax={channels.progress.total || undefined}
        aria-valuenow={channels.progress.total ? channels.progress.done : undefined}
      >
        <div style:width={channels.progress.total ? `${(100 * channels.progress.done) / channels.progress.total}%` : undefined}></div>
      </div>
      <span>{channels.progress.label}</span>
    {:else if channels.source}
      <span>{channels.source}</span>
      <span class="sub">· {plural(t.channels.length, "channel")}, {plural(t.zones.length, "zone")}{#if channels.presets.length}, {plural(channels.presets.length, "range preset")}{/if}</span>
      {#if dirty.any}
        <span class="dirty">· not written: {unwritten}</span>
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
      <button role="tab" aria-selected={tab === "presets"} class:on={tab === "presets"} onclick={() => (tab = "presets")} title="MENU 0 1 4: band scans of your own"
        >Range presets <span>{channels.presets.length}</span></button
      >
    </div>
    <div class="grp adds">
      {#if tab === "channels"}
        <button class="btn" disabled={busy || t.channels.length >= (choices?.maxChannels ?? 4000)} onclick={addChannel}>+ Add channel</button>
        <button class="btn" disabled={busy || t.channels.length >= (choices?.maxChannels ?? 4000)} onclick={() => library.show()} title="Fixed sets, and licensed sites (Canada, US), airports and repeaters near a place">
          Add from library…
        </button>
        <button class="btn" disabled={busy || !t.channels.length} onclick={renumberAsk} title="Number every channel 1, 2, 3… top to bottom, closing the gaps; zones and the home channel follow">
          Renumber…
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
              {#each t.zones as z (z.number)}<option value={String(z.number - 1)}>{z.number} {z.name}{channels.fullZones.has(z.number - 1) ? " (full)" : ""}</option>{/each}
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
            <button
              class="btn quiet"
              disabled={!t.channels.some((c) => c.pos && selected.has(c.number))}
              onclick={() => channels.setMany(selected, { pos: undefined })}
              title="Remove the position from the selected channels">Clear position</button
            >
            <button class="btn quiet" onclick={() => (moveAsk = { picked: [...selected].sort((a, b) => a - b), value: "" })} title="Move them together to numbers from one you type (or drag a ticked row)"
              >Move to…</button
            >
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
                  <th class="sticky2">#</th><th>Name</th><th>RX MHz</th><th>TX MHz</th><th title="Repeater shift: TX minus RX">Shift</th><th title="TX tone, RX tone">Tones TX · RX</th>
                  <th>Power</th><th>Zone</th><th title="Scan skip">Skip</th><th></th>
                </tr>
              </thead>
              <tbody>
                {#each rows as r (r.c ? r.c.number : `gap${r.gap[0]}`)}
                  {#if r.gap}
                    {@const [a, b] = r.gap}
                    <tr
                      class="gap"
                      class:drop-on={gapOver === a}
                      data-gap={a}
                      ondragover={(e) => {
                        if (dragFrom === null || !e.dataTransfer?.types.includes(DRAG)) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        gapOver = a;
                      }}
                      ondragleave={() => gapOver === a && (gapOver = null)}
                      ondrop={(e) => {
                        gapOver = null;
                        if (dragFrom === null || !e.dataTransfer?.types.includes(DRAG)) return;
                        e.preventDefault();
                        dropOn(a, true);
                      }}
                    >
                      <td class="pick sticky"></td>
                      <td class="num sticky2"><span class="gapnum">{a === b ? a : `${a}–${b}`}</span></td>
                      <td colspan="8" class="gaptext">
                        <span>{a === b ? "Empty" : `${b - a + 1} empty numbers`}</span>
                        <button class="btn quiet small" disabled={busy} onclick={() => insertAt(a, null)} aria-label={`Add a channel at ${a}`}>+ Add at {a}</button>
                      </td>
                    </tr>
                  {:else}
                  {@const c = r.c}
                  <ChannelRow
                    {c}
                    zones={t.zones}
                    {choices}
                    state={!baseNums.has(c.number) && channels.base ? "added" : dirty.changed.has(c.number) && channels.base ? "changed" : "same"}
                    selected={selected.has(c.number)}
                    active={activeN === c.number}
                    onselect={(on, range) => tick(c.number, on, range)}
                    onopen={() => (activeN = c.number)}
                    {dragFrom}
                    ongrab={() => (dragFrom = c.number)}
                    onletgo={() => (dragFrom = null)}
                    ondropon={() => dropOn(c.number)}
                    onstep={(dir) => void step(c.number, dir)}
                    onmenu={(x, y) => (rowMenu = { n: c.number, x, y })}
                  />
                  {/if}
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
                onmoved={moved}
              />
            </div>
          {/if}
        </div>
      {/if}
    {:else if tab === "zones"}
      <ZonesEditor {choices} onsay={say} />
    {:else}
      <PresetsEditor onsay={say} />
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

{#if rowMenu}
  {@const n = rowMenu.n}
  {@const row = t.channels.find((c) => c.number === n)}
  {@const group = selected.has(n) && selected.size > 1 ? [...selected].sort((a, b) => a - b) : [n]}
  <div class="rowmenu" role="menu" aria-label={`Channel ${n}`} style:left={`${Math.min(rowMenu.x, window.innerWidth - 250)}px`} style:top={`${Math.min(rowMenu.y, window.innerHeight - 170)}px`}>
    <button role="menuitem" disabled={busy || n <= 0} onclick={() => insertAt(n, row?.zone ?? null)}>
      <b>Insert channel above</b><span>A new channel at {n}; this one and the ones after it move along as far as a gap</span>
    </button>
    <button role="menuitem" disabled={busy || n >= (choices?.maxChannels ?? 4000)} onclick={() => insertAt(n + 1, row?.zone ?? null)}>
      <b>Insert channel below</b><span>A new channel at {n + 1}{t.channels.some((c) => c.number === n + 1) ? "; the ones after it move along as far as a gap" : ""}</span>
    </button>
    <button
      role="menuitem"
      disabled={busy}
      onclick={() => {
        moveAsk = { picked: group, value: "" };
        rowMenu = null;
      }}
    >
      <b>{group.length > 1 ? `Move ${group.length} selected to…` : "Move to…"}</b><span>To numbers from one you type; the ones in the way move along</span>
    </button>
    <hr />
    <button
      role="menuitem"
      class="danger"
      disabled={busy}
      onclick={() => {
        const nums = group; // read first: `group` follows rowMenu, gone once closed
        rowMenu = null;
        remove(nums);
      }}><b>Delete{group.length > 1 ? ` ${group.length} selected` : ""}</b><span>Undo from the notice, or Ctrl+Z</span></button
    >
  </div>
{/if}

{#if moveAsk}
  {@const m = moveAsk}
  <div class="overlay" role="presentation">
    <div class="dialog card" role="dialog" aria-modal="true" aria-labelledby="move-title">
    <form
      class="moveform"
      onsubmit={(e) => {
        e.preventDefault();
        const { picked, value } = m; // read first: `m` follows moveAsk, null once closed
        const start = Number(value);
        if (!value.trim() || !Number.isInteger(start)) return;
        moveAsk = null;
        moveBlock(picked, start);
      }}
    >
      <h2 id="move-title">Move {m.picked.length === 1 ? `channel ${m.picked[0]}` : `${m.picked.length} channels`} to…</h2>
      {#if m.picked.length > 1}<p class="sub">{m.picked.length > 8 ? `${m.picked.slice(0, 8).join(", ")}…` : m.picked.join(", ")}, kept in this order.</p>{/if}
      <label class="movenum">
        First number
        <!-- svelte-ignore a11y_autofocus -->
        <input inputmode="numeric" bind:value={moveAsk.value} autofocus aria-describedby="move-preview" placeholder={`1–${choices?.maxChannels ?? 4000}`} />
      </label>
      <p class="sub" id="move-preview" aria-live="polite">{movePreview}</p>
      <div class="actions">
        <button type="button" class="btn" onclick={() => (moveAsk = null)}>Cancel</button>
        <button type="submit" class="btn primary">Move</button>
      </div>
    </form>
    </div>
  </div>
{/if}

{#if ask}
  <div class="overlay" role="presentation">
    <div class="dialog card" role="dialog" aria-modal="true" aria-labelledby="ask-title">
      <h2 id="ask-title">{ask.text}</h2>
      <p class="sub">{ask.sub ?? "They aren't on the radio yet. Write them first, or save the table to a file, to keep them."}</p>
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
    width: 66px;
    min-width: 66px;
  }
  .grid :global(td.num) {
    white-space: nowrap;
  }
  .grid :global(button.grip) {
    padding: 2px 1px;
    border: 0;
    background: none;
    color: var(--sub);
    opacity: 0.45;
    cursor: grab;
    font-size: 13px;
    line-height: 1;
  }
  .grid :global(tr:hover button.grip),
  .grid :global(button.grip:focus-visible) {
    opacity: 1;
  }
  .grid :global(tr.dragging td) {
    opacity: 0.45;
  }
  .grid :global(tr.drop-above td) {
    box-shadow: inset 0 2px 0 var(--blue);
  }
  .grid :global(tr.drop-below td) {
    box-shadow: inset 0 -2px 0 var(--blue);
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
  .grid :global(td.namecell) {
    white-space: nowrap;
  }
  .grid :global(.pin) {
    display: inline-block;
    width: 16px;
    margin-left: 2px;
    font-size: 12px;
    cursor: default;
    vertical-align: middle;
  }
  .grid :global(input.freq) {
    width: 92px;
    font-family: "JetBrains Mono", monospace;
  }
  .grid :global(input.tone) {
    width: 76px;
  }
  .grid :global(input.shift) {
    width: 86px;
  }
  .grid :global(input.err) {
    outline: 1.5px solid var(--red);
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
  .grid :global(button.more) {
    padding: 0 5px;
    border: 1px solid transparent;
    border-radius: 5px;
    background: none;
    color: var(--sub);
    cursor: pointer;
    opacity: 0.45;
    font-size: 14px;
    line-height: 1.2;
  }
  .grid :global(tr:hover button.more),
  .grid :global(button.more:focus-visible) {
    opacity: 1;
    border-color: var(--line);
  }
  .grid tr.gap td {
    color: var(--sub);
    background: repeating-linear-gradient(-45deg, transparent 0 6px, color-mix(in srgb, var(--line) 35%, transparent) 6px 7px);
    padding-top: 2px;
    padding-bottom: 2px;
  }
  .grid tr.gap.drop-on td {
    box-shadow: inset 0 0 0 2px var(--blue);
  }
  .gapnum {
    padding: 3px 6px 3px 22px;
    font-variant-numeric: tabular-nums;
    font-size: 12px;
  }
  .gaptext {
    font-size: 12px;
  }
  .gaptext span {
    position: sticky;
    left: 120px;
    margin-right: 10px;
  }
  .gaptext .btn.small {
    padding: 1px 8px;
    font-size: 12px;
    opacity: 0;
  }
  tr.gap:hover .gaptext .btn.small,
  .gaptext .btn.small:focus-visible {
    opacity: 1;
  }
  .gaps {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 13px;
    color: var(--sub);
    white-space: nowrap;
    cursor: pointer;
  }
  .rowmenu {
    position: fixed;
    z-index: 26;
    width: 240px;
    display: flex;
    flex-direction: column;
    padding: 4px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface);
    box-shadow: var(--shadow);
  }
  .rowmenu button {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 1px;
    padding: 6px 8px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--text);
    text-align: left;
    cursor: pointer;
    font: inherit;
  }
  .rowmenu button:hover:not(:disabled),
  .rowmenu button:focus-visible {
    background: var(--raised);
  }
  .rowmenu button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .rowmenu button span {
    font-size: 12px;
    color: var(--sub);
  }
  .rowmenu button.danger b {
    color: var(--red);
  }
  .rowmenu hr {
    width: 100%;
    border: 0;
    border-top: 1px solid var(--line);
    margin: 3px 0;
  }
  .moveform {
    display: contents;
  }
  .movenum {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .movenum input {
    width: 100px;
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
