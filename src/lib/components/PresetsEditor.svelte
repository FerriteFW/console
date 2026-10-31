<script lang="ts">
  // The Range presets tab (MENU 0 1 4, NeonPlug's list and detail): the presets on the left, in the radio's order (a
  // new one goes at the end), the chosen one on the right: its name, range, step, mode and resume, checked as the
  // radio checks them (the core runs ferrite's own link session), and its skip list (SCAN-10, LINK-58: the
  // frequencies its scan passes over, up to 48, within its range). Edits are unwritten changes of the table: Write
  // puts them on the radio with the channels, the skip lists after the presets.
  import { channels } from "../channels.svelte";
  import { mhzText, presetChoices, presetSkipParse, P, type Preset, type PresetChoices } from "../core";
  import { radio } from "../radio.svelte";

  let { onsay }: { onsay: (text: string, undo?: boolean) => void } = $props();

  const choices: PresetChoices = presetChoices();
  const list = $derived(channels.presets);
  const dirty = $derived(channels.dirty);
  let pickedN = $state<number | null>(null);
  const p = $derived(pickedN === null ? null : (list.find((x) => x.number === pickedN) ?? null));
  const problem = $derived(p ? (channels.presetProblem($state.snapshot(p) as Preset) ?? "") : "");
  const notRead = $derived(channels.basePresets === null);

  $effect(() => {
    if (pickedN !== null && !list.some((x) => x.number === pickedN)) pickedN = list.length ? Math.min(pickedN, list.length) : null;
    if (pickedN === null && list.length && !narrow()) pickedN = 1;
  });

  function narrow() {
    return typeof window !== "undefined" && window.matchMedia("(max-width: 860px)").matches;
  }

  /** "144-148 MHz", as the radio's list shows a range. */
  function range(x: Preset) {
    const t = (s: string) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);
    return `${t(x.low)}–${t(x.high)} MHz`;
  }

  function add() {
    const n = channels.addPreset(choices.max);
    if (n) pickedN = n;
  }

  function remove(x: Preset) {
    channels.deletePreset(x.number);
    onsay(`Deleted range preset ${x.number} "${x.name}"${x.origin ? " (its skipped frequencies go with it on Write)" : ""}.`, true);
  }

  function set(k: "name" | "low" | "high" | "step" | "mode" | "resume", v: string) {
    if (p) channels.editPreset(p.number, k, v);
  }

  // The skip list: a radio connected without LINK-58 (no caps2 bit) can't take it; offline it is edited for a file.
  const link = $derived(radio.connectedLink);
  const noSkips = $derived(!!link && (link.caps2 & P.caps2.PRESET_SKIPS) === 0);
  const skips = $derived(p?.skips ?? []);
  let skipText = $state("");
  let skipNote = $state("");
  $effect(() => {
    void pickedN;
    skipText = "";
    skipNote = "";
  });
  /** One typed in MHz, onto the end of the list: refused here when it isn't in the range, is there already, or 48 are. */
  function addSkip() {
    if (!p) return;
    const f = presetSkipParse(skipText);
    const low = presetSkipParse(p.low);
    const high = presetSkipParse(p.high);
    if (f === undefined) skipNote = "A frequency in MHz, e.g. 146.52.";
    else if (low !== undefined && high !== undefined && (f < low || f > high)) skipNote = `${mhzText(f)} is outside this range (${range(p)}).`;
    else if (skips.includes(f)) skipNote = `${mhzText(f)} is skipped already.`;
    else if (skips.length >= choices.skipsMax) skipNote = `${choices.skipsMax} at most: remove one first.`;
    else {
      channels.setPresetSkips(p.number, [...skips, f]);
      skipText = "";
      skipNote = "";
    }
  }
  function removeSkip(f: number) {
    if (p) channels.setPresetSkips(p.number, skips.filter((x) => x !== f));
  }

  const changed = (x: Preset) => !!channels.basePresets && dirty.presets.has(x.number);
  const bad = (x: Preset) => !!channels.presetProblem($state.snapshot(x) as Preset);
</script>

<div class="pwork" class:picked={!!p}>
  <section class="list" aria-label="Range presets">
    <header>
      <h2>Range presets</h2>
      <span class="sub">{list.length}/{choices.max}</span>
      <button class="btn small-btn" disabled={list.length >= choices.max} onclick={add} title="A new range at the end (2 m to start with)">+ Add</button>
    </header>
    <ul class="items" role="listbox" aria-label="Range presets">
      {#each list as x (x.number)}
        <li>
          <button role="option" aria-selected={pickedN === x.number} class:on={pickedN === x.number} class:changed={changed(x)} class:added={!x.origin && !notRead} onclick={() => (pickedN = x.number)}>
            <span class="num">{x.number}</span>
            <span class="nm">{x.name || "(no name)"}</span>
            {#if bad(x)}<span class="warn" title={channels.presetProblem($state.snapshot(x) as Preset)}>!</span>{/if}
            <span class="rng">{range(x)}</span>
          </button>
        </li>
      {:else}
        <li class="empty">
          {#if notRead}Read the radio to see its range presets, or add one.{:else}No range presets yet: add one for a band scan of your own.{/if}
        </li>
      {/each}
    </ul>
    {#if dirty.presetsDeleted}<p class="sub small pad">{dirty.presetsDeleted} deleted, not written yet.</p>{/if}
  </section>

  <section class="detail" aria-label={p ? `Range preset ${p.number}` : "Range preset"}>
    {#if p}
      <header>
        <button class="btn quiet back" onclick={() => (pickedN = null)} aria-label="Back to the range presets">← Presets</button>
        <h2>Range preset {p.number}</h2>
        <button class="btn danger" aria-label={`Delete range preset ${p.number}`} title="Delete this preset (undoable)" onclick={() => remove(p)}>Delete</button>
      </header>
      {#if problem}<p class="problem" role="alert">{problem}</p>{/if}

      <div class="settings">
        <label class="wide">
          <span>Name</span>
          <input value={p.name} maxlength={choices.nameLen} onchange={(e) => set("name", e.currentTarget.value)} aria-label="Preset name" />
        </label>
        <label>
          <span>Start MHz</span>
          <input class="mono" value={p.low} inputmode="decimal" onchange={(e) => set("low", e.currentTarget.value)} aria-label="Start MHz" />
        </label>
        <label>
          <span>End MHz</span>
          <input class="mono" value={p.high} inputmode="decimal" onchange={(e) => set("high", e.currentTarget.value)} aria-label="End MHz" />
        </label>
        <label>
          <span>Step</span>
          <select value={p.step} onchange={(e) => set("step", e.currentTarget.value)} aria-label="Step">
            {#each choices.steps as s (s)}<option>{s}</option>{/each}
          </select>
        </label>
        <label>
          <span>Mode</span>
          <select value={p.mode} onchange={(e) => set("mode", e.currentTarget.value)} aria-label="Mode">
            {#each choices.modes as m (m)}<option>{m}</option>{/each}
          </select>
        </label>
        <label>
          <span title="Global follows MENU 0 1 2">Resume</span>
          <select value={p.resume} onchange={(e) => set("resume", e.currentTarget.value)} aria-label="Resume">
            {#each choices.resumes as r (r)}<option>{r}</option>{/each}
          </select>
        </label>
      </div>
      <p class="sub small">18 to 1300 MHz, on one side of 18 and 64 MHz (the band relay's edges: a scan can't cross them). Global resume follows MENU 0 1 2.</p>

      <h3>Skipped frequencies <span class="sub">{skips.length}/{choices.skipsMax}</span></h3>
      <div class="skips" role="group" aria-label="Skipped frequencies">
        <p class="sub">
          This range's scan passes over these. On the radio, <b>#</b> on a hit adds one for good (<b>*</b> skips it for this scan only,
          MENU 0 1 5).
        </p>
        {#if noSkips}
          <p class="note" data-testid="skips-old-firmware">
            This radio's firmware doesn't share skip lists over the link: update Ferrite. The radio keeps its own with this preset; a list
            here stays in the table and in .ferrite files.
          </p>
        {/if}
        {#if skips.length}
          <ul class="skiplist" aria-label="Skipped frequencies of this preset">
            {#each skips as f, i (i)}
              <li>
                <span class="mono">{mhzText(f)}</span>
                <button class="x" aria-label={`Stop skipping ${mhzText(f)}`} title="Remove from the skip list" onclick={() => removeSkip(f)}>✕</button>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="sub none">None skipped.</p>
        {/if}
        <form class="addskip" onsubmit={(e) => (e.preventDefault(), addSkip())}>
          <input
            class="mono"
            bind:value={skipText}
            inputmode="decimal"
            placeholder="MHz, e.g. {p.low.replace(/0+$/, '').replace(/\.$/, '')}"
            aria-label="Frequency to skip"
            aria-invalid={!!skipNote}
            disabled={skips.length >= choices.skipsMax}
          />
          <button class="btn" type="submit" disabled={!skipText.trim() || skips.length >= choices.skipsMax}>Skip it</button>
        </form>
        {#if skipNote}<p class="err" role="alert">{skipNote}</p>{/if}
      </div>
    {:else}
      <p class="empty pick">{list.length ? "Choose a range preset." : "A range preset is a band scan of your own: a start and end, a step, a mode."}</p>
    {/if}
  </section>
</div>

<style>
  .pwork {
    display: grid;
    grid-template-columns: 300px minmax(0, 1fr);
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
    margin: 16px 0 6px;
    font-size: 13px;
  }
  .sub {
    color: var(--sub);
    font-weight: 400;
  }
  .small {
    font-size: 12px;
    margin: 8px 0 0;
  }
  .pad {
    padding: 0 12px 10px;
  }
  input,
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
  .mono {
    font-family: "JetBrains Mono", monospace;
  }
  .items {
    list-style: none;
    margin: 0;
    padding: 6px;
    overflow: auto;
    min-height: 0;
  }
  .items button {
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
  .items button:hover {
    background: var(--raised);
  }
  .items button.on {
    background: var(--focus);
    border-left-color: var(--blue);
  }
  .items button.changed .num {
    color: var(--amber);
  }
  .items button.added .num {
    color: var(--green);
  }
  .num {
    color: var(--sub);
    min-width: 1.8em;
    font-variant-numeric: tabular-nums;
  }
  .nm {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rng {
    color: var(--sub);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
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
    padding-bottom: 14px;
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
    grid-template-columns: minmax(0, 2fr) repeat(2, minmax(0, 1fr));
    gap: 10px;
    margin-top: 12px;
  }
  @container (max-width: 520px) {
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
  .skips {
    padding: 8px 12px;
    border: 1px dashed var(--line);
    border-radius: 6px;
    background: var(--bg);
  }
  .skips p {
    margin: 0 0 4px;
  }
  .skips p:last-child {
    margin: 0;
  }
  .skips .note {
    color: var(--amber);
  }
  .skips .err {
    color: var(--red);
    margin-top: 6px;
  }
  .skiplist {
    list-style: none;
    margin: 8px 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .skiplist li {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 4px 2px 8px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--surface);
    font-variant-numeric: tabular-nums;
  }
  .skiplist .x {
    border: none;
    background: none;
    color: var(--sub);
    cursor: pointer;
    padding: 0 4px;
    font-size: 11px;
  }
  .skiplist .x:hover {
    color: var(--red);
  }
  .none {
    margin: 8px 0 !important;
  }
  .addskip {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .addskip input {
    width: 180px;
  }
  .small-btn {
    padding: 3px 10px;
    font-size: 12px;
  }
  .btn.danger {
    color: var(--red);
  }
  .btn.danger:hover {
    border-color: var(--red);
  }
  @media (max-width: 860px) {
    .pwork {
      grid-template-columns: minmax(0, 1fr);
    }
    .list {
      position: static;
      max-height: none;
    }
    .pwork.picked .list {
      display: none;
    }
    .pwork:not(.picked) .detail {
      display: none;
    }
    .back {
      display: inline-flex;
      padding: 4px 8px;
    }
  }
</style>
