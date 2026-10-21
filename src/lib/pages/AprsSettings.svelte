<script lang="ts">
  // APRS › APRS Settings: the APRS record (LINK-43: MENU 0 5's frequency, beacon, power, path, digipeater, beacon
  // after voice, SSID, custom path), shown as the menu shows it and changed with the menu's own choices and checks
  // (the core runs ferrite's App and link session). Written as Radio Settings writes: a backup file first, the diff,
  // then the write and a read back. APRS mode and the rest of MENU 0 5 are in the settings record (Radio Settings).
  import SettingRows from "../components/SettingRows.svelte";
  import SettingsWriteDialog from "../components/SettingsWriteDialog.svelte";
  import { aprsSettings as s } from "../aprsSettings.svelte";
  import { radio } from "../radio.svelte";
  import type { SettingItem } from "../core";

  let fileInput: HTMLInputElement;
  const connected = $derived(radio.phase === "connected");
  const busy = $derived(!!s.busy || (!!s.write && s.write.step !== "review" && s.write.step !== "done"));
  const dirty = $derived(s.dirty);

  // The record's settings by the menu's third-level lists (Station, Beacon, Path, Radio, Digipeater).
  const groups = $derived.by(() => {
    const out: { path: string; name: string; items: SettingItem[]; note: string }[] = [];
    for (const i of s.view?.items ?? []) {
      const path = i.path.split(" ").slice(0, 3).join(" ");
      let g = out.find((x) => x.path === path);
      if (!g) out.push((g = { path, name: i.sub || "APRS", items: [], note: "" }));
      g.items.push({ ...i, sub: "" });
    }
    return out;
  });

  let autoRead = false;
  $effect(() => {
    if (connected && !s.record && !s.busy && !autoRead) {
      autoRead = true;
      void s.read();
    }
    if (!connected) {
      autoRead = false;
      s.forget();
    }
  });

  async function read() {
    if (dirty.size && !confirm("Read from the radio and drop the unwritten edits?")) return;
    await s.read();
  }

  async function pick(e: Event) {
    const el = e.currentTarget as HTMLInputElement;
    const f = el.files?.[0];
    el.value = "";
    if (f) s.loadFile(await f.text(), f.name);
  }
</script>

<div class="pg">
  <div class="pg-bar" role="toolbar" aria-label="APRS settings">
    <div class="grp">
      <button class="btn" disabled={!connected || busy} onclick={read} title="Read the APRS record from the radio">Read from radio</button>
      <button
        class="btn primary"
        disabled={!connected || busy || !s.record || !s.lengthOk}
        onclick={() => s.startWrite()}
        title="Backs the radio's APRS settings up to a file, shows what changes, then writes on your OK"
      >
        Write to radio…
      </button>
      <button class="btn quiet" disabled={!dirty.size || busy} onclick={() => s.revert()} title="Back to what was read">Undo edits</button>
    </div>
    <div class="grp">
      <span class="label">Backup</span>
      <button class="btn" disabled={!connected || busy} onclick={() => s.backupOnly()}>Back up radio</button>
      <button class="btn" disabled={busy || !s.record} onclick={() => s.saveEdited()}>Save edited</button>
      <button class="btn" disabled={busy} onclick={() => fileInput.click()}>Load file…</button>
      <input bind:this={fileInput} type="file" accept=".json,application/json" hidden onchange={pick} />
    </div>
  </div>

  <div class="pg-status" aria-live="polite" data-status>
    {#if s.busy}
      <span>{s.busy}…</span>
    {:else if s.source}
      <span>{s.source}</span>
      {#if dirty.size}<span class="dirty">· not written: {dirty.size} {dirty.size === 1 ? "setting" : "settings"} changed</span>{/if}
    {:else if connected}
      <span>Read from radio to see its APRS settings, or load a backup.</span>
    {:else}
      <span>Connect, then read. Backup files work without a radio.</span>
    {/if}
  </div>
  {#if s.error}<div class="pg-banner">{s.error}</div>{/if}
  {#each s.view?.notes ?? [] as n, i (i)}<div class="pg-banner warn">{n}</div>{/each}

  {#if s.view}
    <SettingRows {groups} {dirty} refused={s.refused} {busy} change={(id, v) => s.change(id, v)} />
    <p class="dim foot">APRS mode, the symbol, comment, position and the rest of MENU 0 5 are in Radio Settings (0 5).</p>
  {/if}
</div>

<SettingsWriteDialog store={s} what="APRS settings" />

<style>
  .dirty {
    color: var(--amber);
  }
  .foot {
    font-size: 12px;
    margin: 0;
  }
</style>
