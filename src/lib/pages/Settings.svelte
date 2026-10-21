<script lang="ts">
  // Radio Settings: the radio-wide settings record, grouped and named as the radio's menu (MENU 0) shows it, edited
  // with the menu's own choices, and written back after a backup file and a diff. The menu, its values and its
  // checks are ferrite's own (the core runs its App); nothing here knows a setting by name.
  import SettingsWriteDialog from "../components/SettingsWriteDialog.svelte";
  import { settings } from "../settings.svelte";
  import { radio } from "../radio.svelte";
  import type { SettingItem } from "../core";

  let fileInput: HTMLInputElement;
  let search = $state("");

  const connected = $derived(radio.phase === "connected");
  const busy = $derived(!!settings.busy || (!!settings.write && settings.write.step !== "review" && settings.write.step !== "done"));
  const view = $derived(settings.view);
  const dirty = $derived(settings.dirty);
  const groups = $derived.by(() => {
    const q = search.trim().toLowerCase();
    if (!view) return [];
    return view.groups
      .map((g) => ({
        ...g,
        items: g.items.filter(
          (i) => !q || `${i.path} ${i.name} ${i.sub} ${i.value} ${g.name}`.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.items.length || (!q && g.note));
  });

  async function read() {
    if (dirty.size && !confirm("Read from the radio and drop the unwritten edits?")) return;
    await settings.read();
  }

  async function pick(e: Event) {
    const el = e.currentTarget as HTMLInputElement;
    const f = el.files?.[0];
    el.value = "";
    if (f) settings.loadFile(await f.text(), f.name);
  }

  const label = (i: SettingItem) => (i.path ? `${i.path} ${i.name}` : i.name);
  const options = (i: SettingItem) => (i.choices.includes(i.value) ? i.choices : [i.value, ...i.choices]);
  const at = (i: SettingItem) => i.choices.indexOf(i.value);
  function step(i: SettingItem, d: number) {
    const k = at(i) + d;
    if (k >= 0 && k < i.choices.length) settings.change(i.id, i.choices[k]);
  }
</script>

<div class="page">
  <div class="toolbar" role="toolbar" aria-label="Settings">
    <div class="grp">
      <button class="btn" disabled={!connected || busy} onclick={read} title="Read the settings record from the radio">Read from radio</button>
      <button
        class="btn primary"
        disabled={!connected || busy || !settings.record || !settings.lengthOk}
        onclick={() => settings.startWrite()}
        title="Backs the radio's settings up to a file, shows what changes, then writes on your OK"
      >
        Write to radio…
      </button>
      <button class="btn quiet" disabled={!dirty.size || busy} onclick={() => settings.revert()} title="Back to what was read">Undo edits</button>
    </div>
    <div class="grp">
      <span class="label">Backup</span>
      <button class="btn" disabled={!connected || busy} onclick={() => settings.backupOnly()} title="Read the radio's settings and save them to a file">Back up radio</button>
      <button class="btn" disabled={busy || !settings.record} onclick={() => settings.saveEdited()} title="These settings as a backup file">Save edited</button>
      <button class="btn" disabled={busy} onclick={() => fileInput.click()} title="A backup file into the editor; Write then restores it">Load file…</button>
      <input bind:this={fileInput} type="file" accept=".json,application/json" hidden onchange={pick} />
    </div>
    {#if view}
      <input class="search" type="search" placeholder="Find a setting" aria-label="Find a setting" bind:value={search} />
    {/if}
  </div>

  <div class="status">
    {#if settings.busy}
      <span>{settings.busy}…</span>
    {:else if settings.source}
      <span>{settings.source}</span>
      {#if dirty.size}<span class="dirty">· not written: {dirty.size} {dirty.size === 1 ? "setting" : "settings"} changed</span>{/if}
    {:else if connected}
      <span>Read from radio to see its settings, or load a backup.</span>
    {:else}
      <span>Connect (cable, Bluetooth or the demo radio), then read. Backup files work without a radio.</span>
    {/if}
  </div>
  {#if settings.error}<div class="banner">{settings.error}</div>{/if}
  {#each view?.notes ?? [] as n, i (i)}<div class="banner warn">{n}</div>{/each}

  {#if view}
    <div class="groups">
      {#each groups as g (g.path)}
        <section class="card group" aria-label={g.name}>
          <h2><span class="num">{g.path.startsWith("0") ? g.path : ""}</span>{g.name}</h2>
          {#each g.items as i, k (i.id)}
            {#if i.sub && i.sub !== g.items[k - 1]?.sub}
              <h3><span class="num">{i.path.split(" ").slice(0, 3).join(" ")}</span>{i.sub}</h3>
            {/if}
            <div class="row" class:changed={dirty.has(i.id)} class:in-sub={!!i.sub} data-id={i.id} title={i.help}>
              <span class="num">{i.path}</span>
              <span class="name">
                {i.name}
                {#if i.changed}<span class="dot" title="Not the default">•</span>{/if}
              </span>
              <span class="ctl">
                {#if i.kind === "pick"}
                  <select aria-label={label(i)} value={i.value} disabled={busy} onchange={(e) => settings.change(i.id, e.currentTarget.value)}>
                    {#each options(i) as c (c)}<option value={c}>{c}</option>{/each}
                  </select>
                {:else if i.kind === "level"}
                  <span class="stepper" role="group" aria-label={label(i)}>
                    <button class="btn" aria-label={`${label(i)} down`} disabled={busy || at(i) <= 0} onclick={() => step(i, -1)}>−</button>
                    <span class="lv" aria-label={`${label(i)} value`}>{i.value}</span>
                    <button class="btn" aria-label={`${label(i)} up`} disabled={busy || at(i) < 0 || at(i) >= i.choices.length - 1} onclick={() => step(i, 1)}>+</button>
                  </span>
                {:else if i.kind === "text"}
                  <input
                    aria-label={label(i)}
                    value={i.value}
                    placeholder={i.hint}
                    title={i.hint}
                    disabled={busy}
                    onchange={(e) => settings.change(i.id, e.currentTarget.value)}
                  />
                {:else}
                  <span class="ro" aria-label={label(i)}>{i.value || "–"}</span>
                {/if}
              </span>
              {#if i.kind === "readonly" && i.note}<span class="note">{i.note}</span>{/if}
              {#if settings.refused[i.id]}<span class="err">{settings.refused[i.id]}</span>{/if}
            </div>
          {/each}
          {#if g.note}<p class="gnote">{g.note}</p>{/if}
        </section>
      {/each}
    </div>
  {/if}
</div>

<SettingsWriteDialog />

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
  .search {
    margin-left: auto;
    width: 200px;
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
  .banner {
    padding: 8px 12px;
    border: 1px solid var(--red);
    border-radius: 8px;
    color: var(--red);
  }
  .banner.warn {
    border-color: var(--amber);
    color: var(--amber);
  }
  .groups {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
    gap: 14px;
    align-items: start;
  }
  .group {
    padding: 10px 12px 12px;
  }
  h2 {
    margin: 0 0 6px;
    font-size: 14px;
    display: flex;
    gap: 8px;
    align-items: baseline;
  }
  h3 {
    margin: 10px 0 2px;
    font-size: 12px;
    color: var(--sub);
    font-weight: 500;
    display: flex;
    gap: 8px;
    align-items: baseline;
  }
  .num {
    font-family: var(--mono, ui-monospace, monospace);
    color: var(--dim);
    font-size: 11px;
    min-width: 52px;
    font-weight: 400;
  }
  .row {
    display: grid;
    grid-template-columns: 60px 1fr auto;
    align-items: center;
    gap: 2px 8px;
    padding: 4px 0 4px 4px;
    border-bottom: 1px solid var(--line);
    border-left: 2px solid transparent;
    font-size: 13px;
  }
  .row.in-sub .name {
    padding-left: 10px;
  }
  .row.changed {
    border-left-color: var(--amber);
    background: color-mix(in srgb, var(--amber) 6%, transparent);
  }
  .row .num {
    min-width: 0;
  }
  .dot {
    color: var(--blue);
    margin-left: 2px;
  }
  .ctl {
    justify-self: end;
  }
  .ctl select,
  .ctl input {
    min-width: 150px;
    max-width: 220px;
  }
  .stepper {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .stepper .btn {
    width: 28px;
    padding: 2px 0;
    justify-content: center;
  }
  .stepper .lv {
    min-width: 76px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .ro {
    color: var(--sub);
  }
  .note {
    grid-column: 2 / -1;
    justify-self: end;
    color: var(--dim);
    font-size: 11px;
  }
  .err {
    grid-column: 2 / -1;
    color: var(--red);
    font-size: 12px;
  }
  .gnote {
    margin: 8px 0 0;
    color: var(--dim);
    font-size: 11px;
  }
  @media (max-width: 860px) {
    .groups {
      grid-template-columns: 1fr;
    }
    .search {
      margin-left: 0;
      width: 100%;
    }
  }
</style>
