<script lang="ts">
  // APRS › APRS Settings: MENU 0 5 as the link changes it: the APRS record (LINK-43: frequency, beacon, power, path,
  // digipeater, SSID, custom path, FX.25) and the settings no record carries (symbol, comment, ambiguity, Mic-E,
  // telemetry, TX delay and level: the terminal's `dump` and `set`), shown as the menu shows them and changed with the
  // menu's own choices and checks (the core runs ferrite's App and link session). Written as Radio Settings writes: a
  // backup file first, the diff, then the write and a read back. The settings record's MENU 0 5 settings (APRS mode,
  // position, KISS, mute, Shared VHF) are in Radio Settings; the footer names them, from the core.
  import SettingRows from "../components/SettingRows.svelte";
  import SettingsWriteDialog from "../components/SettingsWriteDialog.svelte";
  import { aprsSettings as s } from "../aprsSettings.svelte";
  import { radio } from "../radio.svelte";
  import { backUp, backUpAll, OPEN_ACCEPT, openFile, picked, saveCodeplug } from "../codeplug.svelte";
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


  let notice = $state("");
  /** Open…: a .ferrite (every part into its page) or an older backup; one notice says what was loaded. */
  async function open(e: Event) {
    const f = await picked(e);
    if (!f) return;
    notice = "";
    try {
      const o = await openFile(f);
      // An old backup of this page's own part: the status line already says it was loaded.
      notice = o.parts.length === 1 && o.parts[0] === "aprs" && !o.failed.length ? "" : o.notice;
    } catch (err) {
      s.error = (err as Error).message;
    }
  }

  /** Save as… and Back up radio: the notice says where it went. */
  async function saving(run: () => Promise<string>) {
    s.error = "";
    notice = "";
    try {
      notice = await run();
    } catch (err) {
      s.error = (err as Error).message;
    }
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
      <span class="label">File</span>
      <button class="btn" disabled={busy} onclick={() => fileInput.click()} title="A codeplug (.ferrite) or an older backup (.json) into the editors; Write then puts it on the radio">Open…</button>
      <button class="btn" disabled={busy || !s.record} onclick={() => saving(saveCodeplug)} title="Everything open in Console as one codeplug (.ferrite): these settings with their unwritten edits, the channels, Radio Settings and contacts">Save as…</button>
      <button class="btn" disabled={!connected || busy} onclick={() => saving(() => backUp("aprs"))} title="Read the radio's APRS settings and save them to a .ferrite">Back up APRS</button>
      <button class="btn" disabled={!connected || busy} onclick={() => saving(backUpAll)} title="Read everything the radio holds over the link (channels, settings, APRS settings, lists) into one .ferrite">Back up everything</button>
      <input bind:this={fileInput} type="file" accept={OPEN_ACCEPT} hidden onchange={open} />
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
  {#if notice}<div class="pg-banner ok" aria-live="polite">{notice} <button class="x" aria-label="Dismiss" onclick={() => (notice = "")}>✕</button></div>{/if}
  {#each s.view?.notes ?? [] as n, i (i)}<div class="pg-banner warn">{n}</div>{/each}

  {#if s.view}
    <SettingRows {groups} {dirty} refused={s.refused} {busy} change={(id, v) => s.change(id, v)} />
    {#if s.view.elsewhere.length}
      <p class="dim foot">In Radio Settings (the settings record): {s.view.elsewhere.join(", ")}.</p>
    {/if}
  {/if}
</div>

<SettingsWriteDialog store={s} what="APRS settings" />

<style>
  .pg-banner.ok {
    border-color: var(--line);
    color: var(--text);
  }
  .pg-banner .x {
    background: none;
    border: 0;
    color: inherit;
    cursor: pointer;
  }
  .dirty {
    color: var(--amber);
  }
  .foot {
    font-size: 12px;
    margin: 0;
  }
</style>
