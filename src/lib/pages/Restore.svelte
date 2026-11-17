<script lang="ts">
  // Firmware › Back to stock: Ferrite off a radio (BACKUP-7, BACKUP-8, decision 263). The flow is install.svelte.ts's
  // restore (the backup into Ferrite's own ranges over the link, never calibration or the update area, then the
  // owner's stock .BTF through the bootloader); the plan and the ID checks are the core's.
  import { install as I } from "../install.svelte";
  import { markerWord } from "../core";
  import { Eta, etaText } from "../eta";
  import { radio } from "../radio.svelte";
  import { bridgeEnabled } from "../transport/bridge";

  const bridge = bridgeEnabled();
  void I.load();

  const elsewhere = $derived(!I.connected && radio.phase !== "idle" && radio.phase !== "updating");
  const cableOk = $derived(radio.available().cable === true);

  async function picked(kind: "stock" | "backup" | "icons", e: Event) {
    const el = e.currentTarget as HTMLInputElement;
    const files = Array.from(el.files ?? []);
    el.value = "";
    if (files.length) await I.pickFile(kind, files);
  }
  async function dropped(kind: "stock" | "backup" | "icons", e: DragEvent) {
    e.preventDefault();
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length) await I.pickFile(kind, files);
  }
  const kb = (n: number) => `${Math.round(n / 1024)} KB`;
  /** Seconds left beside the percentage. */
  const eta = new Eta();
  const left = $derived(eta.left(I.done, I.total));
</script>

<div class="page">
  <section class="card" aria-label="Back to stock">
    <h1>Back to stock</h1>
    <p>For a radio that should go back to its stock firmware. Console writes your backup back (never calibration or the update area), then installs your stock firmware. A radio running Ferrite does it itself; one on stock, nicFW, or a Ferrite that won't start gets a small restorer through the bootloader first (“Start from the bootloader”).</p>

    <h2>1. Your files</h2>
    <div class="two">
      <label class="drop" ondragover={(e) => e.preventDefault()} ondrop={(e) => dropped("backup", e)}>
        <input type="file" accept=".fbin,.bin" hidden aria-label="Backup file" onchange={(e) => picked("backup", e)} />
        <span class="what">Your backup (.fbin, or an older .bin)</span>
        <span>{I.restoreBackup ? I.restoreBackup.name : "Drop it here, or click to choose"}</span>
      </label>
      <label class="drop" ondragover={(e) => e.preventDefault()} ondrop={(e) => dropped("stock", e)}>
        <input type="file" accept=".btf,.BTF" hidden aria-label="Stock firmware for Back to stock" onchange={(e) => picked("stock", e)} />
        <span class="what">The stock firmware (.BTF)</span>
        <span>{I.stock ? I.stock.name : "From the radio maker's website: drop it here, or click"}</span>
      </label>
    </div>
    <label class="drop icons" ondragover={(e) => e.preventDefault()} ondrop={(e) => dropped("icons", e)}>
      <input type="file" accept=".bin" hidden aria-label="Menu icons file" onchange={(e) => picked("icons", e)} />
      <span class="what">Stock's menu icons (optional)</span>
      <span data-k="restore-icons">
        {#if I.restoreIconsFrom === "backup"}
          Kept with this backup: they go back too.
        {:else if I.restoreIconsFrom === "file"}
          From the icons file: they go back too.
        {:else}
          Not with this backup (an older .bin, or a radio that had Ferrite before it). Stock's main-menu tiles are in the radio's own flash, which every Ferrite install writes over: without an icons file (Install's "Save them as a file…", from a radio that never had Ferrite) the tiles stay blank on stock. Drop one here.
        {/if}
      </span>
    </label>
    {#if I.restoreIconsError}<p class="warn">{I.restoreIconsError}</p>{/if}
    {#if I.restoreBackup && I.restoreBackupCheck && !I.restoreBackupCheck.problems.filter((p) => !p.startsWith("a stock phone")).length}
      <p class="sub" data-k="restore-id">
        {I.restoreBackupUid ? `Backup of radio ID ${I.restoreBackupUid}.` : "Console doesn't know which radio this backup is from: the radio's ID is asked for first."}
      </p>
      <p class="sub" data-k="restore-marker">
        {I.restoreMarker && markerWord(I.restoreMarker)
          ? `Stock's model marker ${markerWord(I.restoreMarker)} goes back too.`
          : "No stock model marker saved with this backup: stock shows its default model name."}
      </p>
    {/if}

    <h2>2. The radio</h2>
    {#if I.connected}
      <p>Connected: <span data-k="port">{I.label}</span>. Keep the cable in until this says done.</p>
      {#if !I.running && I.restoreStep !== "done"}
        <div class="row"><button class="btn quiet" onclick={() => I.disconnect()}>Disconnect</button></div>
      {/if}
    {:else if elsewhere}
      <p class="warn">Console is connected through the top bar. Back to stock holds the cable for itself: disconnect first.</p>
      <div class="row"><button class="btn" onclick={() => radio.disconnect()}>Disconnect</button></div>
    {:else}
      <p class="sub">Plug in the cable and turn the radio on.</p>
      <div class="row">
        <button class="btn primary" disabled={!cableOk || radio.phase !== "idle"} onclick={() => I.connect("cable")}>Connect cable…</button>
        {#if bridge}<button class="btn" disabled={radio.phase !== "idle"} onclick={() => I.connect("bridge")}>Bridge</button>{/if}
      </div>
      {#if !cableOk}<p class="sub">{radio.available().cable}</p>{/if}
    {/if}
    {#if I.error && I.errorAt === "connect"}<div class="banner" role="alert">{I.error}</div>{/if}

    <h2>3. Back to stock</h2>
    {#if I.restoreBlock && I.restoreStep !== "running"}<p class="sub" data-k="restore-block">{I.restoreBlock}</p>{/if}
    {#if I.restoreConfirmUid && I.restoreStep !== "running" && I.restoreStep !== "done"}
      <div class="banner warn" role="group" aria-label="Confirm the radio">
        <p>
          A backup from another radio overwrites this radio's settings and channels with that radio's. Go on only if this file is this radio's own backup.
          This radio's ID is <strong class="mono">{I.restoreConfirmUid}</strong> (Ferrite shows it under About).
        </p>
        <label class="check">Type this radio's ID: <input class="mono" type="text" autocomplete="off" spellcheck="false" aria-label="This radio's ID" bind:value={I.restoreTyped} /></label>
      </div>
    {/if}
    {#if I.restoreStep !== "done" && I.restoreStep !== "running"}
      <div class="row">
        <button class="btn primary" disabled={!!I.restoreBlock || I.running} onclick={() => I.restore()}>Back to stock</button>
      </div>
    {/if}
    {#if I.restoreSummary}<p class="sub">{kb(I.restoreSummary.bytes)} of Ferrite's storage to write back.</p>{/if}
    {#if I.restoreStep === "running"}
      <div class="progress-box" role="region" aria-label="Progress" aria-live="polite">
        <p>{I.message}</p>
        {#if I.total > 0}<progress max={I.total} value={I.done}></progress><span class="pct">{I.pct}%{etaText(left)}</span>{/if}
        <p class="warn">Keep the cable in and the radio on until this says done.</p>
      </div>
    {/if}
    {#if I.error && I.errorAt === "restore"}<div class="banner" role="alert">{I.error}</div>{/if}
    {#if I.restoreStep !== "running" && I.restoreStep !== "done"}
      <div class="row" data-k="via-restorer">
        <button class="btn" class:primary={I.restoreNoFerrite} disabled={!!I.restoreBlock || I.running || !I.connected || !I.restorerFile} onclick={() => I.restore(true)}>Start from the bootloader</button>
        <span class="sub">Not running Ferrite: turn the radio off and on when Console asks.{#if !I.restorerFile} (This copy of Console has no restorer image.){/if}</span>
      </div>
    {/if}
    {#if I.restoreStep === "failed" && I.restoreWrote}
      <div class="banner warn">
        <p>Part of the backup is written. Don't let Ferrite start again (it would set up its storage over it). Turn the radio off, hold the two lower side keys and turn it on, then:</p>
        <div class="row">
          <button class="btn" disabled={!I.connected || I.running} onclick={() => I.flashStockOnly()}>Send the stock firmware only</button>
        </div>
        <p class="sub">Or start Back to stock again from Ferrite: it writes everything again.</p>
      </div>
    {/if}
    {#if I.restoreStep === "done"}
      <div class="good-box" role="region" aria-label="Back on stock">
        <p><strong>Done.</strong> The radio restarts on stock firmware with your stock data.</p>
      </div>
    {/if}
  </section>
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: 16px;
    max-width: 760px;
  }
  h1 {
    margin: 0 0 8px;
    font-size: 18px;
  }
  h2 {
    margin: 22px 0 6px;
    font-size: 15px;
  }
  p {
    margin: 6px 0;
  }
  .row {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
    margin-top: 8px;
  }
  .mono {
    font-family: var(--mono, monospace);
    font-size: 12px;
  }
  .warn {
    color: var(--amber);
  }
  .banner {
    margin-top: 10px;
    padding: 10px 14px;
    border: 1px solid var(--red);
    border-radius: 8px;
    color: var(--red);
  }
  .banner.warn {
    border-color: var(--amber);
    color: var(--text);
  }
  .progress-box {
    margin-top: 10px;
  }
  progress {
    width: 70%;
    vertical-align: middle;
  }
  .pct {
    margin-left: 8px;
  }
  .good-box {
    margin-top: 10px;
    padding: 10px 14px;
    border: 1px solid var(--green);
    border-radius: 8px;
  }
  .drop {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 16px;
    border: 1px dashed var(--line);
    border-radius: 8px;
    text-align: center;
    cursor: pointer;
    color: var(--sub);
    overflow-wrap: anywhere;
  }
  .drop .what {
    color: var(--text);
    font-weight: 600;
  }
  .drop:hover {
    background: var(--raised);
    border-color: var(--blue);
  }
  .two {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .check {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
    margin-top: 8px;
  }
  @media (max-width: 600px) {
    .two {
      grid-template-columns: 1fr;
    }
  }
</style>
