<script lang="ts">
  // Install: a stock radio to Ferrite, and back to stock, in cards that unlock in order (decision 261). The flow is
  // install.svelte.ts; the checks, the reader's dump, the SSB patch and the restore's plan are the core's
  // (core/src/install.rs). `#install` shows this page alone.
  import { install as I } from "../install.svelte";
  import { radio } from "../radio.svelte";
  import { signatureText } from "../signature";
  import { bridgeEnabled } from "../transport/bridge";

  let { focus = false }: { focus?: boolean } = $props();
  const bridge = bridgeEnabled();
  void I.load();

  type Badge = { text: string; cls: string };
  const badge = (s: string): Badge =>
    ({
      locked: { text: "Waiting", cls: "" },
      ready: { text: "Ready", cls: "blue" },
      running: { text: "Working", cls: "amber" },
      done: { text: "Done", cls: "green" },
      failed: { text: "Stopped", cls: "red" },
      optional: { text: "Optional", cls: "" },
      save: { text: "Save the file", cls: "amber" },
    })[s] ?? { text: s, cls: "" };

  const connectState = $derived(I.connected ? "done" : "ready");
  const backupState = $derived(
    !I.connected && I.backupStep === "idle" ? "locked" : I.backupStep === "done" ? (I.saved ? "done" : "save") : I.backupStep === "idle" ? "ready" : I.backupStep,
  );
  const ssbState = $derived(!I.unlocked ? "locked" : I.ssb ? "done" : "optional");
  const installState = $derived(!I.unlocked ? "locked" : I.installStep === "idle" ? (I.installBlock ? "locked" : "ready") : I.installStep);
  // Back to stock stays folded away until asked for, or until a file is dropped into it (a backup picked by mistake
  // in the install chain can't start it: it needs its own button anyway).
  let undoOpen = $state(false);
  const undoShown = $derived(undoOpen || !!I.restoreBackup || I.restoreStep !== "idle");
  const restoreState = $derived(I.restoreStep === "idle" ? (I.restoreBlock ? "locked" : "ready") : I.restoreStep);

  async function picked(kind: "ferrite" | "reader" | "stock" | "backup", e: Event) {
    const el = e.currentTarget as HTMLInputElement;
    const files = Array.from(el.files ?? []);
    el.value = "";
    if (files.length) await I.pickFile(kind, files);
  }
  async function dropped(kind: "stock" | "backup", e: DragEvent) {
    e.preventDefault();
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length) await I.pickFile(kind, files);
  }
  async function checkSaved(e: Event) {
    const el = e.currentTarget as HTMLInputElement;
    const f = el.files?.[0];
    el.value = "";
    if (f) await I.checkSaved(f);
  }
  const kb = (n: number) => `${Math.round(n / 1024)} KB`;
  const short = (h: string) => `${h.slice(0, 16)}…`;
</script>

{#snippet head(n: string, title: string, state: string)}
  {@const b = badge(state)}
  <div class="head">
    <h2><span class="n">{n}</span>{title}</h2>
    <span class="tag {b.cls}" data-state={state}>{b.text}</span>
  </div>
{/snippet}

{#snippet err(at: string)}
  {#if I.error && I.errorAt === at}<div class="banner" role="alert">{I.error}</div>{/if}
{/snippet}

{#snippet progress(show: boolean)}
  {#if show}
    <div class="progress-box" role="region" aria-label="Progress" aria-live="polite">
      <p>{I.message}</p>
      {#if I.total > 0}
        <progress max={I.total} value={I.done}></progress><span class="pct">{I.pct}%</span>
      {/if}
    </div>
  {/if}
{/snippet}

<div class="page" class:focus>
  <section class="card intro">
    <h1>Install Ferrite</h1>
    <ul>
      <li>For a Radtel RT-950 Pro on the programming cable. Chrome or Edge, or the desktop app.</li>
      <li>Console first backs up the radio's whole flash, calibration included. You keep that file: it's the way back.</li>
      <li>Then it installs Ferrite. Calibration and the bootloader's update area are never written.</li>
      <li>Back to stock is not part of installing: it sits apart, at the bottom, for taking Ferrite off a radio.</li>
    </ul>
  </section>

  <section class="card" aria-label="Connect">
    {@render head("1", "Connect", connectState)}
    {#if I.connected}
      <p>Connected: <span data-k="port">{I.label}</span>. Keep the cable in until each step says done.</p>
      <div class="row"><button class="btn" disabled={I.running} onclick={() => I.disconnect()}>Disconnect</button></div>
    {:else}
      <p class="sub">Plug in the cable and turn the radio on. Any firmware is fine: stock, Ferrite, or a radio waiting in its bootloader.</p>
      {#if radio.phase === "connected" && I.installStep === "done"}
        <p class="good">Connected to Ferrite as usual: the cable is Console's again.</p>
      {:else if radio.phase !== "idle" && radio.phase !== "updating"}
        <p class="warn">Console is connected elsewhere: disconnect there first.</p>
      {/if}
      <div class="row">
        <button class="btn primary" disabled={radio.available().cable !== true || radio.phase !== "idle"} onclick={() => I.connect("cable")}>Connect cable…</button>
        {#if bridge}<button class="btn" disabled={radio.phase !== "idle"} onclick={() => I.connect("bridge")}>Bridge</button>{/if}
      </div>
      {#if radio.available().cable !== true}<p class="sub">{radio.available().cable}</p>{/if}
    {/if}
    {@render err("connect")}
  </section>

  <section class="card" aria-label="Back up">
    {@render head("2", "Back up", backupState)}
    <p class="sub">Loads a small reader into the radio, reads all 4 MB of its flash and checks it against the radio's own CRC. About 4 minutes.</p>
    {#if I.backupStep !== "running" && I.backupStep !== "done"}
      <div class="row">
        <button class="btn primary" disabled={!I.connected || I.running || !I.readerFile} onclick={() => I.backUp()}>Back up the radio</button>
      </div>
      {#if !I.readerFile}<p class="sub">No reader image in this copy of Console: pick one under Advanced.</p>{/if}
    {/if}
    {@render progress(I.backupStep === "running")}
    {@render err("backup")}
    {#if I.check && I.backupStep === "done"}
      <dl class="facts" aria-label="Backup">
        <dt>Radio ID</dt>
        <dd data-k="uid">{I.uid || "not reported"}</dd>
        <dt>Flash</dt>
        <dd>{I.chip}</dd>
        <dt>Checked</dt>
        <dd data-k="verified">CRC {I.check.crc32} matches the radio's</dd>
        <dt>SHA-256</dt>
        <dd class="mono" title={I.check.sha256}>{short(I.check.sha256)}</dd>
        <dt>File</dt>
        <dd class="mono" data-k="name">{I.backupName}</dd>
      </dl>
      <details>
        <summary>CRC per region</summary>
        <table class="tbl regions">
          <tbody>
            {#each I.check.regions as r (r.start)}
              <tr><td>{r.name}</td><td class="mono">{r.start.toString(16).padStart(6, "0")}-{(r.end - 1).toString(16).padStart(6, "0")}</td><td class="mono">{r.crc32}</td></tr>
            {/each}
          </tbody>
        </table>
      </details>
      {#if I.check.pending_update}
        <div class="banner warn" role="alert">
          A stock phone or Bluetooth update is waiting in this radio. Ferrite can't be installed over it. Keep this backup, let stock finish or clear that update, then back up again.
        </div>
      {/if}
      {#if !I.saved}
        <div class="save" role="group" aria-label="Save the backup">
          <p><strong>Save this file before anything else.</strong> Keep it somewhere safe, off this computer too. It's the only way back to a fully working stock radio.</p>
          <div class="row">
            {#if !I.downloaded}
              <button class="btn primary" onclick={() => I.save()}>Save backup…</button>
            {:else}
              <button class="btn" onclick={() => I.confirmSaved()}>I have saved it</button>
              <label class="btn quiet">Check the saved file…<input type="file" hidden aria-label="Saved backup" onchange={checkSaved} /></label>
              <button class="btn quiet" onclick={() => I.downloadAgain()}>Download again</button>
            {/if}
          </div>
          {#if I.downloaded}<p class="sub">Check your downloads folder for {I.backupName}, then confirm.</p>{/if}
          {#if I.saveError}<p class="warn">{I.saveError}</p>{/if}
        </div>
      {:else}
        <p class="good" data-k="saved">Saved: {I.savedWhere}</p>
      {/if}
    {/if}
  </section>

  <section class="card" aria-label="SSB patch">
    {@render head("3", "SSB receive (optional)", ssbState)}
    <p class="sub">USB, LSB and CW need a patch only stock firmware carries. Drop in your own stock .BTF from Radtel and Console takes the patch from it, here in your browser. Without it, Ferrite installs and those modes stay hidden.</p>
    {#if I.unlocked}
      <label class="drop" ondragover={(e) => e.preventDefault()} ondrop={(e) => dropped("stock", e)}>
        <input type="file" accept=".btf,.BTF" hidden aria-label="Stock firmware file" onchange={(e) => picked("stock", e)} />
        {I.stock ? I.stock.name : "Drop your stock .BTF here, or click to choose"}
      </label>
      {#if I.ssb}
        <p class="good" data-k="ssb">SSB patch found: {I.ssb.records} records, {I.ssb.known ? "the known stock patch" : "not one Ferrite knows (the radio asks before storing it)"}.</p>
      {:else if I.ssbError}
        <p class="warn">{I.ssbError}</p>
      {/if}
      {#if I.stock}
        <label class="check"><input type="checkbox" checked={I.keepStock} onchange={(e) => I.setKeepStock((e.currentTarget as HTMLInputElement).checked)} /> Keep this file in this browser for Back to stock</label>
      {/if}
    {/if}
  </section>

  <section class="card" aria-label="Install Ferrite">
    {@render head("4", "Install Ferrite", installState)}
    {#if I.ferrite && I.ferriteCheck}
      <p>
        <span data-k="release">Ferrite {I.ferriteCheck.version ?? "(no version)"}</span>
        {#if I.ferriteSource === "bundled"}<span class="sub">, included with Console, checksum checked</span>{:else}<span class="sub">, from {I.ferrite.name}</span>{/if}
        {#if I.ssb}<span class="sub">, with your SSB patch</span>{/if}
      </p>
      <!-- A bad signature is also in the image's problems (the install block says it once unlocked). -->
      {#if I.ferriteSignature && !(I.ferriteSignature.kind === "bad" && I.unlocked)}
        <p class={I.ferriteSignature.kind === "bad" ? "warn" : "sub"} data-k="signature">{signatureText(I.ferriteSignature)}</p>
      {/if}
    {:else if I.releaseError}
      <p class="warn">{I.releaseError}</p>
    {/if}
    {#if I.unlocked && I.installStep !== "done"}
      {#if I.installBlock}
        <p class="warn" data-k="install-block">{I.installBlock}</p>
      {:else}
        <ul class="sub">
          <li>Keep the cable in. About a minute.</li>
          <li>Ferrite then starts, sets up its storage and opens its first-run setup.</li>
        </ul>
      {/if}
      <div class="row">
        <button class="btn primary" disabled={!!I.installBlock || I.running} onclick={() => I.install()}>Install Ferrite</button>
      </div>
    {/if}
    {@render progress(I.installStep === "running")}
    {@render err("install")}
    {#if I.installStep === "done"}
      <div class="good-box" role="region" aria-label="Installed">
        <p><strong>Done.</strong> {I.installed ? `The radio runs Ferrite ${I.installed}.` : "The radio restarts into Ferrite. Finish the setup on the radio."}</p>
        <p>That's the whole install: nothing below is a next step. Keep your backup file safe.</p>
        {#if focus}<p><a href="#/live">Open Ferrite Console</a></p>{/if}
      </div>
    {/if}
  </section>

  <div class="split" aria-hidden="true"><span>Undo: take Ferrite off a radio</span></div>

  <section class="card undo" aria-label="Back to stock">
    {@render head("", "Back to stock", restoreState)}
    <p class="sub">Not part of installing. Only for a radio on Ferrite that should go back to stock: Console writes your backup back (never calibration or the update area), then installs your stock firmware.</p>
    {#if !undoShown}
      <div class="row"><button class="btn quiet" onclick={() => (undoOpen = true)}>Show Back to stock…</button></div>
    {/if}
    <div class="undo-body" hidden={!undoShown}>
    <div class="two">
      <label class="drop" ondragover={(e) => e.preventDefault()} ondrop={(e) => dropped("backup", e)}>
        <input type="file" accept=".bin" hidden aria-label="Backup file" onchange={(e) => picked("backup", e)} />
        {I.restoreBackup ? I.restoreBackup.name : "Your backup (.bin)"}
      </label>
      <label class="drop" ondragover={(e) => e.preventDefault()} ondrop={(e) => dropped("stock", e)}>
        <input type="file" accept=".btf,.BTF" hidden aria-label="Stock firmware for Back to stock" onchange={(e) => picked("stock", e)} />
        {I.stock ? I.stock.name : "Your stock .BTF"}
      </label>
    </div>
    {#if I.restoreBackup && I.restoreBackupCheck && !I.restoreBackupCheck.problems.filter((p) => !p.startsWith("a stock phone")).length}
      <p class="sub" data-k="restore-id">
        {I.restoreBackupUid ? `Backup of radio ID ${I.restoreBackupUid}.` : "Console doesn't know which radio this backup is from: the radio's ID is asked for first."}
      </p>
    {/if}
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
    {#if I.restoreStep !== "done"}
      <div class="row">
        <button class="btn" disabled={!!I.restoreBlock || I.running} onclick={() => I.restore()}>Back to stock</button>
      </div>
    {/if}
    {#if I.restoreSummary}<p class="sub">{kb(I.restoreSummary.bytes)} of Ferrite's storage to write back.</p>{/if}
    {@render progress(I.restoreStep === "running")}
    {@render err("restore")}
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
    </div>
  </section>

  <details class="card advanced">
    <summary>Advanced</summary>
    <div class="adv">
      <div>
        <h3>Ferrite image</h3>
        <p class="sub">Use a file instead of the release included with Console. Pick its .minisig with it to check Ferrite's signature.</p>
        <label class="btn">Use a file…<input type="file" accept=".btf,.BTF,.minisig" multiple hidden aria-label="Ferrite file" onchange={(e) => picked("ferrite", e)} /></label>
        {#if I.ferriteCheck?.problems.length}<ul class="warn">{#each I.ferriteCheck.problems as p, i (i)}<li>{p}</li>{/each}</ul>{/if}
      </div>
      <div>
        <h3>Reader image</h3>
        <p class="sub">The image that reads the flash for the backup. It can't write: it has no write code at all.</p>
        <label class="btn">Use a file…<input type="file" accept=".btf,.BTF,.minisig" multiple hidden aria-label="Reader file" onchange={(e) => picked("reader", e)} /></label>
        {#if I.readerFile}<p class="sub">{I.readerFile.name} ({I.readerSource === "bundled" ? "included" : "file"}){#if I.readerSignature && I.readerSignature.kind !== "bad"}. {signatureText(I.readerSignature)}{/if}</p>{/if}
        {#if I.readerCheck?.problems.length}<ul class="warn">{#each I.readerCheck.problems as p, i (i)}<li>{p}</li>{/each}</ul>{/if}
      </div>
    </div>
  </details>
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: 16px;
    max-width: 760px;
  }
  .page.focus {
    margin: 0 auto;
  }
  h1 {
    margin: 0 0 8px;
    font-size: 18px;
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  h2 {
    margin: 0;
    font-size: 15px;
  }
  h3 {
    margin: 0 0 4px;
    font-size: 13px;
  }
  .n {
    display: inline-block;
    min-width: 20px;
    color: var(--sub);
  }
  p {
    margin: 6px 0;
  }
  ul {
    margin: 0;
    padding-left: 18px;
  }
  li {
    margin: 2px 0;
  }
  .row {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
    margin-top: 8px;
  }
  .facts {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 4px 14px;
    margin: 10px 0;
  }
  dt {
    color: var(--sub);
  }
  dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .mono {
    font-family: var(--mono, monospace);
    font-size: 12px;
  }
  .regions {
    margin-top: 6px;
  }
  .good {
    color: var(--green);
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
  .save {
    margin-top: 10px;
    border: 1px solid var(--amber);
    border-radius: 8px;
    padding: 10px 14px;
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
    display: block;
    margin-top: 8px;
    padding: 16px;
    border: 1px dashed var(--line);
    border-radius: 8px;
    text-align: center;
    cursor: pointer;
    color: var(--sub);
    overflow-wrap: anywhere;
  }
  .drop:hover {
    background: var(--raised);
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
    margin-top: 8px;
  }
  .split {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 28px 0 4px;
    color: var(--sub);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .split::before,
  .split::after {
    content: "";
    flex: 1;
    border-top: 1px dashed var(--line);
  }
  .undo {
    border-color: var(--amber);
    border-style: dashed;
  }
  .advanced summary {
    cursor: pointer;
    font-weight: 600;
  }
  .adv {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    margin-top: 10px;
  }
  @media (max-width: 600px) {
    .two,
    .adv {
      grid-template-columns: 1fr;
    }
  }
</style>
