<script lang="ts">
  // The Zones tab (NeonPlug's zone editor, in Ferrite's model): the zones on the left (a new one named at the top),
  // the chosen zone on the right: its name and settings, its channels in order with ▲ ▼ ✕, and every other channel
  // to bring in. A channel is in one zone at most, so bringing one in moves it from its zone. A zone's order is its
  // channels' numbers: ▲ ▼ swap a channel's number with its neighbour's in the zone, so the radio's order changes
  // too, and what names a channel by number (priority channels, the home channel) goes with it.
  import { channels } from "../channels.svelte";
  import { normalizeZone, type Choices, type Zone } from "../core";

  let { choices, onsay }: { choices: Choices; onsay: (text: string, undo?: boolean) => void } = $props();

  const t = $derived(channels.table);
  const dirty = $derived(channels.dirty);
  /** The zone on the right, by number. */
  let pickedN = $state<number | null>(null);
  let newName = $state("");
  let addNote = $state("");
  let search = $state("");

  const zone = $derived(pickedN === null ? null : (t.zones.find((z) => z.number === pickedN) ?? null));
  const members = $derived(zone ? t.channels.filter((c) => c.zone === zone.number - 1) : []);
  const counts = $derived.by(() => {
    const m = new Map<number, number>();
    for (const c of t.channels) if (c.zone !== null) m.set(c.zone, (m.get(c.zone) ?? 0) + 1);
    return m;
  });
  const others = $derived(zone ? t.channels.filter((c) => c.zone !== zone.number - 1) : []);
  const found = $derived.by(() => {
    const q = search.trim().toLowerCase();
    if (!q) return others;
    return others.filter((c) => c.name.toLowerCase().includes(q) || c.rx.startsWith(q) || String(c.number) === q || zoneName(c.zone).toLowerCase().includes(q));
  });
  const problem = $derived(zone ? zoneProblem(zone) : "");
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  // The first zone is chosen when there is none (a read, a delete); a choice that went away is dropped.
  $effect(() => {
    if (pickedN !== null && !t.zones.some((z) => z.number === pickedN)) pickedN = null;
    if (pickedN === null && t.zones.length && !narrow()) pickedN = 1;
  });

  function narrow() {
    return typeof window !== "undefined" && window.matchMedia("(max-width: 860px)").matches;
  }

  function zoneName(i: number | null) {
    if (i === null) return "no zone";
    const z = t.zones[i];
    return z ? `${z.number} ${z.name}` : `zone ${i + 1} (missing)`;
  }

  function add(e: Event) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    addNote = channels.addZone(name, choices.maxZones);
    if (!addNote) {
      newName = "";
      pickedN = t.zones.length;
    }
  }

  function zoneSet<K extends keyof Zone>(z: Zone, k: K, v: Zone[K]) {
    const next = { ...$state.snapshot(z), [k]: v } as Zone;
    let out = next;
    try {
      out = normalizeZone(next);
    } catch {
      /* kept as typed: the problem shows */
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
    const n = counts.get(z.number - 1) ?? 0;
    channels.deleteZone(z.number);
    pickedN = null;
    onsay(`Deleted zone ${z.number} "${z.name}"${n ? `; its ${plural(n, "channel")} now in no zone` : ""}.`, true);
  }

  /** ▲ ▼: the channel trades numbers with its neighbour in the zone. */
  function swap(i: number, j: number) {
    // The numbers, not the rows: the rows' numbers change in the swap.
    const a = members[i]?.number;
    const b = members[j]?.number;
    if (a === undefined || b === undefined) return;
    channels.swap(a, b);
    const home = channels.home === undefined ? ` The home channel wasn't read: if it was ${a} or ${b}, set it again on the radio.` : "";
    onsay(`Channels ${Math.min(a, b)} and ${Math.max(a, b)} swapped numbers. A slot on either on the radio tunes the other after Write.${home}`, true);
  }

  function bringIn(nums: number[]) {
    if (!zone || !nums.length) return;
    const from = new Set(t.channels.filter((c) => nums.includes(c.number) && c.zone !== null).map((c) => c.zone));
    // CHAN-35: a zone holds 256; as many as fit go, and the refusal says how many.
    const full = channels.moveToZone(nums, zone.number - 1);
    if (full) onsay(full, true);
    else if (nums.length > 1) onsay(`${plural(nums.length, "channel")} into zone ${zone.number}${from.size ? " (moved from their zones)" : ""}.`, true);
  }

  function takeOut(n: number) {
    channels.moveToZone([n], null);
  }
</script>

<div class="zwork" class:picked={!!zone}>
  <section class="list" aria-label="Zones">
    <header>
      <h2>Zones</h2>
      <span class="sub">{t.zones.length}/{choices.maxZones}</span>
    </header>
    <form class="addrow" onsubmit={add}>
      <input
        bind:value={newName}
        oninput={() => (addNote = "")}
        placeholder="Zone name…"
        maxlength="16"
        aria-label="New zone name"
        disabled={t.zones.length >= choices.maxZones}
      />
      <button class="btn" type="submit" disabled={!newName.trim() || t.zones.length >= choices.maxZones}>Add</button>
    </form>
    {#if addNote}<p class="err small" role="alert">{addNote}</p>{/if}
    <ul class="zones" role="listbox" aria-label="Zones">
      {#each t.zones as z (z.number)}
        {@const n = counts.get(z.number - 1) ?? 0}
        <li>
          <button
            role="option"
            aria-selected={pickedN === z.number}
            class:on={pickedN === z.number}
            class:changed={!!channels.base && dirty.zones.has(z.number)}
            onclick={() => (pickedN = z.number)}
          >
            <span class="num">{z.number}</span>
            <span class="nm">{z.name}</span>
            {#if zoneProblem(z)}<span class="warn" title={zoneProblem(z)}>!</span>{/if}
            <span class="count" title={plural(n, "channel")}>{n}</span>
          </button>
        </li>
      {:else}
        <li class="empty">No zones yet: name one above to add it.</li>
      {/each}
    </ul>
  </section>

  <section class="detail" aria-label={zone ? `Zone ${zone.number}` : "Zone"}>
    {#if zone}
      <header>
        <button class="btn quiet back" onclick={() => (pickedN = null)} aria-label="Back to the zones">← Zones</button>
        <h2>Zone {zone.number}</h2>
        <button class="btn danger" title="Delete this zone; its channels go to no zone (undoable)" aria-label={`Delete zone ${zone.number}`} onclick={() => deleteZone(zone)}
          >Delete</button
        >
      </header>
      {#if problem}<p class="problem" role="alert">{problem}</p>{/if}

      <div class="settings">
        <label class="wide">
          <span>Name</span>
          <input value={zone.name} maxlength="16" onchange={(e) => zoneSet(zone, "name", e.currentTarget.value)} aria-label="Zone name" />
        </label>
        <label>
          <span>Resume</span>
          <select value={zone.resume} onchange={(e) => zoneSet(zone, "resume", e.currentTarget.value)} aria-label="Resume">
            {#each choices.resumes as r (r)}<option>{r}</option>{/each}
          </select>
        </label>
        <label>
          <span title="Seconds, or the radio's">Dwell</span>
          <input value={zone.dwell} onchange={(e) => zoneSet(zone, "dwell", e.currentTarget.value)} aria-label="Dwell" />
        </label>
        <label>
          <span>Priority 1</span>
          <input value={zone.pri1 ?? ""} placeholder="–" inputmode="numeric" onchange={(e) => zoneSet(zone, "pri1", pri(e.currentTarget.value))} aria-label="Priority channel 1" />
        </label>
        <label>
          <span>Priority 2</span>
          <input value={zone.pri2 ?? ""} placeholder="–" inputmode="numeric" onchange={(e) => zoneSet(zone, "pri2", pri(e.currentTarget.value))} aria-label="Priority channel 2" />
        </label>
        <div class="flags">
          <label class="flag" title="In the scan-all set">
            <input type="checkbox" checked={zone.scan_all} onchange={(e) => zoneSet(zone, "scan_all", e.currentTarget.checked)} aria-label="Scan all" />
            <span>Scan all</span>
          </label>
          <label class="flag" title="Shown in ◀▶ on home">
            <input type="checkbox" checked={zone.shown} onchange={(e) => zoneSet(zone, "shown", e.currentTarget.checked)} aria-label="Shown" />
            <span>Shown</span>
          </label>
          <label class="flag" title="Scanned nearest first">
            <input type="checkbox" checked={zone.by_distance} onchange={(e) => zoneSet(zone, "by_distance", e.currentTarget.checked)} aria-label="By distance" />
            <span>By distance</span>
          </label>
        </div>
      </div>

      <h3>Channels in this zone <span class="sub">({members.length}/{choices.zoneCap})</span></h3>
      <p class="sub small">In channel-number order. ▲ ▼ swap a channel's number with its neighbour's, so the radio's order changes too.</p>
      {#if members.length}
        <ol class="members" aria-label="Channels in this zone">
          {#each members as c, i (c.number)}
            <li class:changed={!!channels.base && dirty.changed.has(c.number)}>
              <span class="num">{c.number}</span>
              <span class="nm">{c.name || "(no name)"}</span>
              <span class="mhz">{c.rx}</span>
              {#if channels.home === c.number}<span class="tag" title="The radio's home channel (hold 0)">home</span>{/if}
              <span class="acts">
                <button class="ib" disabled={i === 0} onclick={() => swap(i, i - 1)} aria-label={`Move channel ${c.number} up`} title="Swap numbers with the channel above">▲</button>
                <button class="ib" disabled={i === members.length - 1} onclick={() => swap(i, i + 1)} aria-label={`Move channel ${c.number} down`} title="Swap numbers with the channel below">▼</button>
                <button class="ib del" onclick={() => takeOut(c.number)} aria-label={`Take channel ${c.number} out of the zone`} title="Out of this zone (to no zone)">✕</button>
              </span>
            </li>
          {/each}
        </ol>
      {:else}
        <p class="empty">No channels in this zone yet: add them from the list below.</p>
      {/if}

      <div class="avail-head">
        <h3>Other channels <span class="sub">({found.length} of {others.length})</span></h3>
        {#if found.length > 1}
          <button class="btn quiet small-btn" onclick={() => bringIn(found.map((c) => c.number))} title="Every channel shown into this zone (moved from theirs)"
            >Move all {found.length} here</button
          >
        {/if}
      </div>
      <input class="search" type="search" placeholder="Find: name, MHz, number or zone" aria-label="Find a channel to add" bind:value={search} />
      <ul class="avail" aria-label="Other channels">
        {#each found as c (c.number)}
          <li>
            <span class="num">{c.number}</span>
            <span class="nm">{c.name || "(no name)"}</span>
            <span class="mhz">{c.rx}</span>
            <span class="where" class:none={c.zone === null}>{zoneName(c.zone)}</span>
            <button class="btn small-btn" onclick={() => bringIn([c.number])} aria-label={`${c.zone === null ? "Add" : "Move"} channel ${c.number} here`}
              >{c.zone === null ? "Add" : "Move here"}</button
            >
          </li>
        {:else}
          <li class="empty">{others.length ? "No channel matches." : "Every channel is in this zone."}</li>
        {/each}
      </ul>
    {:else}
      <p class="empty pick">{t.zones.length ? "Choose a zone to see its channels." : "Add a zone to group channels: zones are also what the radio scans."}</p>
    {/if}
  </section>
</div>

<style>
  .zwork {
    display: grid;
    grid-template-columns: 280px minmax(0, 1fr);
    gap: 12px;
    align-items: start;
    min-width: 0;
  }
  section {
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface);
    min-width: 0;
    font-size: 13px;
  }
  .list {
    display: flex;
    flex-direction: column;
    position: sticky;
    top: 64px;
    max-height: calc(100vh - 80px);
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--line);
  }
  h2 {
    margin: 0;
    font-size: 15px;
    flex: 1;
  }
  h3 {
    margin: 14px 0 4px;
    font-size: 13px;
  }
  .sub {
    color: var(--sub);
    font-weight: 400;
  }
  .small {
    font-size: 12px;
    margin: 0 0 6px;
  }
  .err {
    color: var(--red);
    padding: 0 12px;
  }
  .addrow {
    display: flex;
    gap: 6px;
    padding: 10px 12px;
  }
  input:not([type="checkbox"]),
  select {
    height: 32px;
    padding: 0 8px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--bg);
    color: var(--text);
    font: inherit;
    min-width: 0;
  }
  .addrow input {
    flex: 1;
  }
  .zones {
    list-style: none;
    margin: 0;
    padding: 0 6px 6px;
    overflow: auto;
    min-height: 0;
  }
  .zones button {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 7px 8px;
    border: none;
    border-left: 3px solid transparent;
    border-radius: 6px;
    background: none;
    text-align: left;
    cursor: pointer;
  }
  .zones button:hover {
    background: var(--raised);
  }
  .zones button.on {
    background: var(--focus);
    border-left-color: var(--blue);
  }
  .zones button.changed .num {
    color: var(--amber);
  }
  .num {
    color: var(--sub);
    min-width: 2.6em;
    font-variant-numeric: tabular-nums;
  }
  .nm {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .count {
    color: var(--sub);
    font-size: 12px;
  }
  .warn {
    display: inline-grid;
    place-items: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--red);
    color: var(--bg);
    font-weight: 700;
    font-size: 12px;
  }
  .empty {
    color: var(--sub);
    padding: 12px;
    list-style: none;
  }
  .pick {
    padding: 36px 16px;
    text-align: center;
    margin: 0;
  }
  .detail {
    padding-bottom: 12px;
    container-type: inline-size;
  }
  .detail > :not(header) {
    margin-left: 12px;
    margin-right: 12px;
  }
  .back {
    display: none;
  }
  .problem {
    margin-top: 10px;
    padding: 6px 10px;
    border: 1px solid var(--red);
    border-radius: 6px;
    color: var(--red);
  }
  .settings {
    display: grid;
    grid-template-columns: minmax(0, 2fr) repeat(4, minmax(0, 1fr));
    gap: 10px;
    margin-top: 12px;
  }
  @container (max-width: 560px) {
    .settings {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    }
    .settings .wide {
      grid-column: span 2;
    }
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  label > span {
    color: var(--sub);
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .flags {
    grid-column: 1 / -1;
    display: flex;
    flex-wrap: wrap;
    gap: 6px 18px;
  }
  label.flag {
    flex-direction: row;
    align-items: center;
    gap: 8px;
    cursor: pointer;
  }
  label.flag span {
    color: var(--text);
    font-size: 13px;
    text-transform: none;
    letter-spacing: 0;
  }
  .members,
  .avail {
    list-style: none;
    padding: 0;
    border: 1px solid var(--line);
    border-radius: 6px;
    overflow: auto;
    background: var(--bg);
  }
  .members {
    margin-top: 0;
    max-height: 40vh;
  }
  .avail {
    margin-top: 6px;
    max-height: 45vh;
  }
  .members li,
  .avail li:not(.empty) {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--line);
    min-width: 0;
  }
  .members li:last-child,
  .avail li:last-child {
    border-bottom: none;
  }
  .members li.changed {
    background: color-mix(in srgb, var(--amber) 9%, var(--bg));
    box-shadow: inset 3px 0 0 var(--amber);
  }
  .mhz {
    color: var(--sub);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .tag {
    font-size: 11px;
    color: var(--green);
    border: 1px solid var(--green);
    border-radius: 4px;
    padding: 0 4px;
  }
  .where {
    color: var(--violet);
    font-size: 12px;
    max-width: 12em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .where.none {
    color: var(--dim);
  }
  .acts {
    display: flex;
    gap: 2px;
  }
  .ib {
    width: 28px;
    height: 26px;
    border: 1px solid var(--line);
    border-radius: 5px;
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
    font-size: 11px;
  }
  .ib:hover:not(:disabled) {
    border-color: var(--blue);
  }
  .ib:disabled {
    opacity: 0.3;
    cursor: default;
  }
  .ib.del:hover {
    border-color: var(--red);
    color: var(--red);
  }
  .small-btn {
    padding: 3px 10px;
    font-size: 12px;
  }
  .avail-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-top: 14px;
  }
  .avail-head h3 {
    margin: 0;
  }
  .search {
    width: calc(100% - 24px);
    margin-top: 6px;
  }
  .btn.danger {
    color: var(--red);
  }
  .btn.danger:hover {
    border-color: var(--red);
  }
  @media (max-width: 860px) {
    .zwork {
      grid-template-columns: minmax(0, 1fr);
    }
    .list {
      position: static;
      max-height: none;
    }
    .zwork.picked .list {
      display: none;
    }
    .zwork:not(.picked) .detail {
      display: none;
    }
    .back {
      display: inline-flex;
      padding: 4px 8px;
    }
    .where {
      max-width: 7em;
    }
    .mhz {
      display: none;
    }
  }
</style>
