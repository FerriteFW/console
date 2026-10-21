<script lang="ts">
  // Channels & Zones (UV Studio's channel editor, in Ferrite's look): the radio's channels and zones read into a
  // table, edited in place, and written back after a backup file and a diff. CHIRP CSV in and out; backup files
  // saved and loaded (a load is a restore: Write shows the same diff and asks).
  import ChannelRow from "../components/ChannelRow.svelte";
  import WriteDialog from "../components/WriteDialog.svelte";
  import ImportDialog from "../components/ImportDialog.svelte";
  import LibraryDialog from "../components/library/LibraryDialog.svelte";
  import { library } from "../library.svelte";
  import { channels } from "../channels.svelte";
  import { radio } from "../radio.svelte";
  import { channelChoices, loadCore, normalizeZone, type Choices, type Zone } from "../core";

  let choices = $state<Choices | null>(null);
  loadCore().then(() => (choices = channelChoices()));

  let tab = $state<"channels" | "zones">("channels");
  let zoneFilter = $state("all");
  let search = $state("");
  let chirpInput: HTMLInputElement;
  let fileInput: HTMLInputElement;

  const connected = $derived(radio.phase === "connected");
  const busy = $derived(!!channels.progress || (!!channels.write && channels.write.step !== "review" && channels.write.step !== "done"));
  const t = $derived(channels.table);
  const dirty = $derived(channels.dirty);
  const baseNums = $derived(new Set((channels.base?.channels ?? []).map((c) => c.number)));
  const shown = $derived.by(() => {
    const q = search.trim().toLowerCase();
    return t.channels.filter((c) => {
      if (zoneFilter === "none" && c.zone !== null) return false;
      if (zoneFilter !== "all" && zoneFilter !== "none" && c.zone !== Number(zoneFilter)) return false;
      return !q || c.name.toLowerCase().includes(q) || c.rx.startsWith(q) || String(c.number) === q;
    });
  });
  const toneWords = $derived(choices ? ["off", ...choices.ctcss, ...choices.dcs.flatMap((d) => [`D${d}N`, `D${d}I`])] : []);
  const inZone = (i: number) => t.channels.filter((c) => c.zone === i).length;

  async function read() {
    if (dirty.any && !confirm("Read from the radio and drop the table's unwritten edits?")) return;
    await channels.read();
  }

  async function pick(e: Event, then: (text: string, name: string) => void) {
    const el = e.currentTarget as HTMLInputElement;
    const f = el.files?.[0];
    el.value = "";
    if (f) then(await f.text(), f.name);
  }

  function zoneSet<K extends keyof Zone>(z: Zone, k: K, v: Zone[K]) {
    const next = { ...$state.snapshot(z), [k]: v } as Zone;
    let out = next;
    try {
      out = normalizeZone(next);
    } catch {
      /* kept as typed */
    }
    channels.setZone(z.number, out);
  }
  function zoneProblem(z: Zone): string {
    try {
      normalizeZone($state.snapshot(z) as Zone);
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  }
  const pri = (v: string) => (v.trim() === "" ? null : Number(v));

  function deleteZone(z: Zone) {
    const n = inZone(z.number - 1);
    if (n && !confirm(`Delete zone ${z.number} "${z.name}"? Its ${n} channels move to no zone; later zones move up one.`)) return;
    channels.deleteZone(z.number);
  }

  function addChannel() {
    const n = channels.addChannel();
    zoneFilter = "all";
    search = "";
    if (n) queueMicrotask(() => document.querySelector<HTMLInputElement>(`tr[data-n="${n}"] input.name`)?.focus());
  }
</script>

<div class="page">
  <div class="toolbar" role="toolbar" aria-label="Channels">
    <div class="grp">
      <button class="btn" disabled={!connected || busy} onclick={read} title="Read every zone and channel from the radio">Read from radio</button>
      <button
        class="btn primary"
        disabled={!connected || busy || !channels.base && !t.channels.length}
        onclick={() => channels.startWrite()}
        title="Backs the radio up to a file, shows what changes, then writes on your OK"
      >
        Write to radio…
      </button>
      <button class="btn quiet" disabled={!dirty.any || !channels.base || busy} onclick={() => channels.revert()} title="Back to what was read">Undo edits</button>
    </div>
    <div class="grp">
      <button class="btn" disabled={busy || t.channels.length >= 1000} onclick={() => library.show()} title="Fixed sets, airports and Canadian licensed sites near a place">Add channels…</button>
    </div>
    <div class="grp">
      <span class="label">CHIRP CSV</span>
      <button class="btn" disabled={busy} onclick={() => chirpInput.click()}>Import…</button>
      <button class="btn" disabled={busy || !t.channels.length} onclick={() => channels.exportChirp()}>Export</button>
      <input bind:this={chirpInput} type="file" accept=".csv,text/csv" hidden onchange={(e) => pick(e, (s, n) => channels.importChirp(s, n))} />
    </div>
    <div class="grp">
      <span class="label">Backup</span>
      <button class="btn" disabled={!connected || busy} onclick={() => channels.backupOnly()} title="Read the radio and save it to a file">Back up radio</button>
      <button class="btn" disabled={busy || !t.channels.length && !t.zones.length} onclick={() => channels.saveTable()} title="The table as a backup file">Save table</button>
      <button class="btn" disabled={busy} onclick={() => fileInput.click()} title="A backup file into the table; Write then restores it">Load file…</button>
      <input bind:this={fileInput} type="file" accept=".json,application/json" hidden onchange={(e) => pick(e, (s, n) => channels.loadFile(s, n))} />
    </div>
  </div>

  <div class="status">
    {#if channels.progress}
      <div class="bar"><div style:width={`${(100 * channels.progress.done) / Math.max(1, channels.progress.total)}%`}></div></div>
      <span>{channels.progress.label}</span>
    {:else if channels.source}
      <span>{channels.source}</span>
      <span class="sub">· {t.channels.length} channels, {t.zones.length} zones</span>
      {#if dirty.any}
        <span class="dirty"
          >· not written: {dirty.changed.size} channels changed or added{#if dirty.deleted}, {dirty.deleted} deleted{/if}{#if dirty.zones.size || dirty.zonesDeleted}, {dirty.zones.size + dirty.zonesDeleted} {dirty.zones.size + dirty.zonesDeleted === 1 ? "zone" : "zones"}{/if}</span
        >
      {/if}
    {:else if connected}
      <span>Read from radio to fill the table, or add channels, import a CHIRP file or load a backup.</span>
    {:else}
      <span>Connect (cable, Bluetooth or the demo radio), then read. Files work without a radio.</span>
    {/if}
  </div>
  {#if channels.error}<div class="banner">{channels.error}</div>{/if}
  {#if channels.notes.length}
    <details class="notes" open={channels.notes.length < 4}>
      <summary>{channels.notes.length} {channels.notes.length === 1 ? "note" : "notes"}</summary>
      <ul>{#each channels.notes as n, i (i)}<li>{n}</li>{/each}</ul>
    </details>
  {/if}

  <div class="tabs" role="tablist">
    <button role="tab" aria-selected={tab === "channels"} class:on={tab === "channels"} onclick={() => (tab = "channels")}>Channels <span>{t.channels.length}</span></button>
    <button role="tab" aria-selected={tab === "zones"} class:on={tab === "zones"} onclick={() => (tab = "zones")}>Zones <span>{t.zones.length}</span></button>
  </div>

  {#if choices}
    {#if tab === "channels"}
      <div class="filters">
        <label
          >Zone
          <select bind:value={zoneFilter}>
            <option value="all">All</option>
            <option value="none">No zone</option>
            {#each t.zones as z (z.number)}<option value={String(z.number - 1)}>{z.number} {z.name}</option>{/each}
          </select>
        </label>
        <input class="search" type="search" placeholder="Find: name, MHz or number" bind:value={search} />
        <span class="spacer"></span>
        <button class="btn" disabled={busy || t.channels.length >= 1000} onclick={addChannel}>+ Channel</button>
      </div>
      <datalist id="tone-words">{#each toneWords as w (w)}<option value={w}></option>{/each}</datalist>
      <div class="scroll">
        <table class="grid">
          <thead>
            <tr>
              <th class="sticky">#</th><th class="sticky2">Name</th><th>RX MHz</th><th>Duplex</th><th>Offset / TX</th><th>Mode</th>
              <th>TX tone</th><th>RX tone</th><th>Power</th><th>Step</th><th>Squelch</th><th>Zone</th>
              <th title="Scan skip">Skip</th><th title="Priority">Pri</th><th>APRS</th><th title="Never transmits">RX only</th>
              <th>Hidden</th><th title="Busy lockout">Busy</th><th title="Reverse">Rev</th><th>End tone</th><th>Tail</th><th></th>
            </tr>
          </thead>
          <tbody>
            {#each shown as c (c.number)}
              <ChannelRow
                {c}
                zones={t.zones}
                {choices}
                state={!baseNums.has(c.number) && channels.base ? "added" : dirty.changed.has(c.number) && channels.base ? "changed" : "same"}
              />
            {:else}
              <tr><td colspan="22" class="empty">{t.channels.length ? "No channel matches." : "No channels in the table."}</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else}
      <div class="filters">
        <span class="sub">Zones are numbered in order; a new one is the next number. Deleting one moves its channels to no zone.</span>
        <span class="spacer"></span>
        <button class="btn" disabled={busy || t.zones.length >= 254} onclick={() => channels.addZone()}>+ Zone</button>
      </div>
      <div class="scroll">
        <table class="grid zones">
          <thead>
            <tr>
              <th>#</th><th>Name</th><th>Channels</th><th title="In the scan-all set">Scan all</th><th title="Shown in ◀▶ on home">Shown</th>
              <th>By distance</th><th>Resume</th><th title="Seconds, or the radio's">Dwell</th><th>Priority 1</th><th>Priority 2</th><th></th>
            </tr>
          </thead>
          <tbody>
            {#each t.zones as z (z.number)}
              {@const prob = zoneProblem(z)}
              <tr class:changed={channels.base && dirty.zones.has(z.number)} class:bad={!!prob}>
                <td class="num">{z.number}</td>
                <td><input class="name" value={z.name} maxlength="16" onchange={(e) => zoneSet(z, "name", e.currentTarget.value)} aria-label="Zone name" /></td>
                <td class="sub">{inZone(z.number - 1)}</td>
                <td class="ck"><input type="checkbox" checked={z.scan_all} onchange={(e) => zoneSet(z, "scan_all", e.currentTarget.checked)} aria-label="Scan all" /></td>
                <td class="ck"><input type="checkbox" checked={z.shown} onchange={(e) => zoneSet(z, "shown", e.currentTarget.checked)} aria-label="Shown" /></td>
                <td class="ck"><input type="checkbox" checked={z.by_distance} onchange={(e) => zoneSet(z, "by_distance", e.currentTarget.checked)} aria-label="By distance" /></td>
                <td>
                  <select value={z.resume} onchange={(e) => zoneSet(z, "resume", e.currentTarget.value)} aria-label="Resume">
                    {#each choices.resumes as r (r)}<option>{r}</option>{/each}
                  </select>
                </td>
                <td><input class="small" value={z.dwell} onchange={(e) => zoneSet(z, "dwell", e.currentTarget.value)} aria-label="Dwell" /></td>
                <td><input class="small" value={z.pri1 ?? ""} placeholder="–" onchange={(e) => zoneSet(z, "pri1", pri(e.currentTarget.value))} aria-label="Priority channel 1" /></td>
                <td><input class="small" value={z.pri2 ?? ""} placeholder="–" onchange={(e) => zoneSet(z, "pri2", pri(e.currentTarget.value))} aria-label="Priority channel 2" /></td>
                <td class="act">
                  {#if prob}<span class="warn" title={prob}>!</span>{/if}
                  <button class="del" title="Delete this zone" aria-label={`Delete zone ${z.number}`} onclick={() => deleteZone(z)}>✕</button>
                </td>
              </tr>
            {:else}
              <tr><td colspan="11" class="empty">No zones in the table.</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}
</div>

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
  }
  .grp .label {
    font-size: 11px;
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
    height: 6px;
    border-radius: 3px;
    background: var(--raised);
    overflow: hidden;
  }
  .bar div {
    height: 100%;
    background: var(--blue);
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
  .tabs {
    display: flex;
    gap: 4px;
    border-bottom: 1px solid var(--line);
  }
  .tabs button {
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
    color: var(--dim);
    font-weight: 400;
    margin-left: 4px;
  }
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
    font-size: 13px;
  }
  .spacer {
    flex: 1;
  }
  .search {
    width: 240px;
  }
  .scroll {
    overflow: auto;
    max-height: calc(100vh - 290px);
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
  .grid :global(th.sticky),
  .grid :global(td.sticky) {
    position: sticky;
    left: 0;
    z-index: 1;
  }
  .grid :global(th.sticky2),
  .grid :global(td.sticky2) {
    position: sticky;
    left: 52px;
    z-index: 1;
  }
  .grid :global(th.sticky),
  .grid :global(th.sticky2) {
    z-index: 3;
  }
  .grid :global(td.sticky) {
    width: 52px;
    min-width: 52px;
  }
  .grid :global(tr.changed td) {
    background: color-mix(in srgb, var(--amber) 9%, var(--bg));
  }
  .grid :global(tr.added td) {
    background: color-mix(in srgb, var(--green) 9%, var(--bg));
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
  .grid :global(input.n) {
    width: 46px;
    color: var(--sub);
  }
  .grid :global(input.name) {
    width: 150px;
  }
  .grid :global(input.freq) {
    width: 92px;
    font-family: "JetBrains Mono", monospace;
  }
  .grid :global(input.tone) {
    width: 70px;
  }
  .grid :global(input.small) {
    width: 60px;
  }
  .grid :global(td.ck) {
    text-align: center;
  }
  .grid :global(td.num) {
    color: var(--sub);
  }
  .grid :global(td.act) {
    text-align: right;
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
    color: var(--dim);
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
  input[type="search"],
  .filters select {
    font: inherit;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 7px;
    padding: 5px 8px;
  }
  @media (max-width: 860px) {
    .scroll {
      max-height: none;
    }
    .search {
      width: 100%;
    }
  }
</style>
