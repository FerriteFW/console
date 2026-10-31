<script lang="ts">
  // The Range presets tab (MENU 0 1 4, NeonPlug's list and detail): the presets on the left, in the radio's order (a
  // new one goes at the end), the chosen one on the right: its name, range, step, mode and resume, checked as the
  // radio checks them (the core runs ferrite's own link session), and what the radio keeps beside it (its skipped
  // frequencies, SCAN-10). Edits are unwritten changes of the table: Write puts them on the radio with the channels.
  import { channels } from "../channels.svelte";
  import { presetChoices, type Preset, type PresetChoices } from "../core";

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

      <h3>Skipped frequencies</h3>
      <div class="skips">
        <p>
          The radio keeps up to 48 for each range: on a hit during this range's scan, <b>#</b> adds the frequency for good
          (<b>*</b> skips it for this scan only, MENU 0 1 5).
        </p>
        <p class="sub">
          {#if p.origin}
            The link doesn't carry them yet, so they aren't listed here; they stay with this preset when you edit it, and go with it if you delete it.
          {:else}
            A new preset starts with none.
          {/if}
        </p>
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
