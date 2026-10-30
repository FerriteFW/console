<script lang="ts">
  // Radio Settings: the radio-wide settings record, grouped and named as the radio's menu (MENU 0) shows it, edited
  // with the menu's own choices, and written back after a backup file and a diff. The menu, its values and its
  // checks are ferrite's own (the core runs its App); nothing here knows a setting by name.
  import SettingsWriteDialog from "../components/SettingsWriteDialog.svelte";
  import SettingRows from "../components/SettingRows.svelte";
  import { settings } from "../settings.svelte";
  import { radio } from "../radio.svelte";
  import { backUp, OPEN_ACCEPT, openFile, picked, saveCodeplug } from "../codeplug.svelte";

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

  // Opening the page reads the radio when there's nothing yet (the record is small: well under a second on the cable).
  let autoRead = false;
  $effect(() => {
    if (connected && !settings.record && !settings.busy && !autoRead) {
      autoRead = true;
      void settings.read();
    }
    if (!connected) autoRead = false;
  });


  async function read() {
    if (dirty.size && !confirm("Read from the radio and drop the unwritten edits?")) return;
    await settings.read();
  }


  let notice = $state("");
  /** Open…: a .ferrite (every part into its page) or an older backup; one notice says what was loaded. */
  async function open(e: Event) {
    const f = await picked(e);
    if (!f) return;
    notice = "";
    try {
      const o = await openFile(f);
      // An old backup of this page's own part: the status line already says it was loaded.
      notice = o.parts.length === 1 && o.parts[0] === "settings" && !o.failed.length ? "" : o.notice;
    } catch (err) {
      settings.error = (err as Error).message;
    }
  }

  /** Save as… and Back up radio: the notice says where it went. */
  async function saving(run: () => Promise<string>) {
    settings.error = "";
    notice = "";
    try {
      notice = await run();
    } catch (err) {
      settings.error = (err as Error).message;
    }
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
      <span class="label">File</span>
      <button class="btn" disabled={busy} onclick={() => fileInput.click()} title="A codeplug (.ferrite) or an older backup (.json) into the editors; Write then puts it on the radio">Open…</button>
      <button class="btn" disabled={busy || !settings.record} onclick={() => saving(saveCodeplug)} title="Everything open in Console as one codeplug (.ferrite): these settings with their unwritten edits, the channels, APRS settings and contacts">Save as…</button>
      <button class="btn" disabled={!connected || busy} onclick={() => saving(() => backUp("settings"))} title="Read the radio's settings and save them to a .ferrite">Back up radio</button>
      <input bind:this={fileInput} type="file" accept={OPEN_ACCEPT} hidden onchange={open} />
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
  {#if notice}<div class="banner ok" aria-live="polite">{notice} <button class="x" aria-label="Dismiss" onclick={() => (notice = "")}>✕</button></div>{/if}
  {#each view?.notes ?? [] as n, i (i)}<div class="banner warn">{n}</div>{/each}

  {#if view}
    <SettingRows {groups} {dirty} refused={settings.refused} {busy} change={(id, v) => settings.change(id, v)} />
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
    width: 220px;
    height: 32px;
    padding: 0 10px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--bg);
    color: var(--text);
    font: inherit;
    font-size: 13px;
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
  .banner.ok {
    border-color: var(--line);
    color: var(--text);
  }
  .banner .x {
    background: none;
    border: 0;
    color: inherit;
    cursor: pointer;
  }
  .banner.warn {
    border-color: var(--amber);
    color: var(--amber);
  }
  @media (max-width: 900px) {
    .search {
      margin-left: 0;
      width: 100%;
    }
  }
</style>
