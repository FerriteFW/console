<script lang="ts">
  let iconsNote = $state("");
  // Install as a full-screen wizard (Alex, Oct 29): Connect → Back up → Install → Done, one step on screen. SSB has
  // no step of its own (decision 457): nothing to choose, so the Install step says in one line whether it comes along.
  // The flow and every gate are install.svelte.ts's (decision 261; BACKUP-2: nothing writes until the backup is
  // verified and saved): this only shows the step the flow is at. It can't be closed while the radio is busy.
  import { install as I, markerText } from "../install.svelte";
  import { Eta, etaText } from "../eta";
  import { radio } from "../radio.svelte";
  import { saveLine } from "../download";
  import { signatureText } from "../signature";
  import { bridgeEnabled } from "../transport/bridge";

  let { onclose, home = "#/live" }: { onclose: () => void; home?: string } = $props();
  const bridge = bridgeEnabled();
  void I.load();

  const names = ["Connect", "Back up", "Install", "Done"];
  const step = $derived(I.installStep === "done" ? 4 : I.installStep !== "idle" || I.unlocked ? 3 : I.connected || I.backupStep !== "idle" ? 2 : 1);
  /** Console's usual connection (the top bar) holds the radio: it runs Ferrite already. */
  const elsewhere = $derived(!I.connected && radio.phase !== "idle" && radio.phase !== "updating");
  const cableOk = $derived(radio.available().cable === true);

  function close() {
    if (I.running) return;
    if (I.connected && I.installStep !== "done") void I.disconnect();
    onclose();
  }
  function keydown(e: KeyboardEvent) {
    if (e.key === "Escape") close();
  }
  function toUpdate() {
    onclose();
    location.hash = "#/firmware";
  }

  async function checkSaved(e: Event) {
    const el = e.currentTarget as HTMLInputElement;
    const f = el.files?.[0];
    el.value = "";
    if (f) await I.checkSaved(f);
  }
  const short = (h: string) => `${h.slice(0, 16)}…`;
  /** Seconds left beside the percentage. */
  const eta = new Eta();
  const left = $derived(eta.left(I.done, I.total));
</script>

<svelte:window onkeydown={keydown} />

{#snippet connect(again: boolean, cancel: boolean)}
  {#if elsewhere}
    <div class="note" role="status">
      <p><strong>This radio already runs Ferrite: use Update.</strong> Console is connected to it through the top bar.</p>
      <div class="row">
        <button class="btn quiet" onclick={() => radio.disconnect()}>Disconnect</button>
        <button class="btn primary" onclick={toUpdate}>Go to Update</button>
      </div>
    </div>
  {:else}
    {#if !cableOk}<p class="sub">{radio.available().cable}</p>{/if}
    {#if cableOk && radio.phase !== "idle" && radio.phase !== "updating"}
      <!-- Never a dead button: say what holds the cable. -->
      <p class="sub">Console is still {radio.phase === "connecting" ? "connecting to the radio" : "connected"} through the top bar{radio.retrying ? " (reconnecting by itself)" : ""}. Press Disconnect at the top first, then Connect cable here.</p>
    {/if}
    <div class="row">
      {#if cancel}<button class="btn" onclick={close}>Cancel</button>{/if}
      {#if bridge}<button class="btn" disabled={radio.phase !== "idle"} onclick={() => I.connect("bridge")}>Bridge</button>{/if}
      <button class="btn primary" disabled={!cableOk || radio.phase !== "idle"} onclick={() => I.connect("cable")}>{again ? "Connect again…" : "Connect cable…"}</button>
    </div>
  {/if}
{/snippet}

{#snippet progress()}
  <div class="progress" role="region" aria-label="Progress" aria-live="polite">
    <p class="msg">{I.message || "Starting…"}</p>
    {#if I.total > 0}
      <progress max={I.total} value={I.done}></progress>
      <p class="sub">{I.pct}%{etaText(left)}</p>
    {/if}
    <p class="warn">Keep the cable in and the radio on until this says done.</p>
  </div>
{/snippet}

{#snippet err(at: string)}
  {#if I.error && I.errorAt === at}<div class="err" role="alert">{I.error}</div>{/if}
{/snippet}

<div class="overlay">
  <div class="panel" role="dialog" aria-modal="true" aria-labelledby="inst-title">
    <div class="top">
      <h2 id="inst-title">Install Ferrite</h2>
      {#if !I.running}<button class="btn quiet x" aria-label="Close" onclick={close}>✕</button>{/if}
    </div>
    <ol class="steps" aria-label="Steps">
      {#each names as name, i (name)}
        <li class:on={step === i + 1} class:past={step > i + 1} aria-current={step === i + 1 ? "step" : undefined}>{name}</li>
      {/each}
    </ol>

    {#if step === 1}
      <h3>Connect the radio</h3>
      <ul class="notes">
        <li>Ferrite runs on the Radtel RT-950 Pro, and radios built on the same hardware.</li>
        <li>Plug in the programming cable and turn the radio on. It can still run its stock firmware: that's what Install is for.</li>
        <li>Console first backs up the radio's whole flash. Nothing is written until you have saved that file.</li>
        <li data-k="install-charge"><strong>Charge the radio to over 50% first.</strong> Console can't read the battery of a radio on its stock firmware, and an install that stops part way can leave it without working firmware.</li>
      </ul>
      {#if I.releaseError}<p class="warn">{I.releaseError}</p>{/if}
      {@render err("connect")}
      {@render connect(false, true)}
    {:else if step === 2}
      <h3>Back up the radio</h3>
      {#if I.connected}<p class="sub">Connected: <span data-k="port">{I.label}</span>.</p>{/if}
      {#if I.backupStep === "idle"}
        <p>Console loads a small read-only reader into the radio, reads all 4 MB of its flash and checks it against the radio's own CRC. About 4 minutes.</p>
        {#if I.readerProblem}<p class="warn" role="alert" data-k="reader-problem">{I.readerProblem}</p>{:else}{@render err("backup")}{/if}
        <div class="row">
          <button class="btn" onclick={close}>Cancel</button>
          <button class="btn primary" disabled={!I.connected || I.running || !!I.readerProblem} onclick={() => I.backUp()}>Back up the radio</button>
        </div>
      {:else if I.backupStep === "running"}
        {@render progress()}
      {:else if I.backupStep === "failed"}
        {@render err("backup")}
        <p class="sub">Nothing was written to the radio. Turn it off and on if it doesn't answer, then try again.</p>
        {#if I.connected}
          <div class="row">
            <button class="btn" onclick={close}>Cancel</button>
            <button class="btn primary" disabled={I.running || !!I.readerProblem} onclick={() => I.backUp()}>Try again</button>
          </div>
        {:else}
          {@render connect(true, true)}
        {/if}
      {:else if I.check}
        <dl class="facts" aria-label="Backup">
          <dt>Radio ID</dt>
          <dd data-k="uid">{I.uid || "not reported"}</dd>
          <dt>Flash</dt>
          <dd>{I.chip}</dd>
          <dt>Model marker</dt>
          <dd data-k="marker">{markerText(I.marker, I.markerRead)}</dd>
          <dt>Menu icons</dt>
          <dd data-k="icons">
            {#if !I.icons}
              not read by this reader
            {:else if I.iconsStock}
              stock's, kept with this backup (Back to stock puts them back)
              <button class="btn quiet" onclick={async () => {
                const r = await I.saveIcons();
                iconsNote = r ? saveLine(r, "Saved") : "";
              }}>Save them as a file…</button>
              {iconsNote}
            {:else}
              not stock's: an earlier Ferrite install wrote over them (Back to stock needs them from a file)
            {/if}
          </dd>
          <dt>Checked</dt>
          <dd data-k="verified">CRC {I.check.crc32} matches the radio's</dd>
          <dt>SHA-256</dt>
          <dd class="mono" title={I.check.sha256}>{short(I.check.sha256)}</dd>
          <dt>File</dt>
          <dd class="mono" data-k="name">{I.backupName}</dd>
        </dl>
        {#if I.check.pending_update}
          <div class="note warn-box" role="alert">
            A stock phone or Bluetooth update is waiting in this radio. Ferrite can't be installed over it. Keep this backup, let stock finish or clear that update, then back up again.
          </div>
        {/if}
        <div class="save" role="group" aria-label="Save the backup">
          <p><strong>Save this file before anything else.</strong> Keep it somewhere safe, off this computer too. It's the only way back to a fully working stock radio.</p>
          <div class="row">
            {#if !I.downloaded}
              <button class="btn primary" onclick={() => I.save()}>Save the backup…</button>
            {:else}
              <button class="btn quiet" onclick={() => I.downloadAgain()}>Download again</button>
              <label class="btn">Check the saved file…<input type="file" hidden aria-label="Saved backup" onchange={checkSaved} /></label>
              <button class="btn primary" onclick={() => I.confirmSaved()}>I have saved it</button>
            {/if}
          </div>
          {#if I.downloaded}<p class="sub">Check your downloads folder for {I.backupName}, then confirm.</p>{/if}
          {#if I.saveError}<p class="warn">{I.saveError}</p>{/if}
        </div>
      {/if}
    {:else if step === 3}
      <h3>Ready to install</h3>
      <p class="good" data-k="saved">Backup saved: {I.savedWhere}</p>
      {#if I.ferrite && I.ferriteCheck}
        <p><span data-k="release">Ferrite {I.ferriteCheck.version ?? "(no version)"}</span>{#if I.ferriteSource === "bundled"}<span class="sub">, {I.ferriteFromFeed ? "downloaded from ferritefw.dev" : "included with Console"}, checksum checked</span>{:else}<span class="sub">, from {I.ferrite.name}</span>{/if}</p>
        <!-- A bad signature is also in the image's problems (the install block says it). -->
        {#if I.ferriteSignature && I.ferriteSignature.kind !== "bad"}
          <p class="sub" data-k="signature">{signatureText(I.ferriteSignature)}</p>
        {/if}
      {:else if I.releaseError}
        <p class="warn">{I.releaseError}</p>
      {/if}
      <!-- INST-10.1, decision 457: the patch from the radio's own stock firmware, or none; never a file asked for. -->
      {#if I.ssb}
        <p class="good" data-k="ssb">Found the SSB patch on the radio. USB, LSB and CW will work.</p>
      {:else if I.icons && !I.iconsStock}
        <p class="sub" data-k="ssb">SSB: the radio keeps what it has. To add it, use Firmware › Add SSB after the install.</p>
      {:else}
        <p class="sub" data-k="ssb">No SSB patch found on the radio. Ferrite installs without it, so USB, LSB and CW stay hidden. You can add them later in Firmware › Add SSB, with your stock .BTF file.</p>
      {/if}
      {#if I.installStep === "idle"}
        {#if I.installBlock}
          <p class="warn" data-k="install-block">{I.installBlock}</p>
        {:else}
          <ul class="notes">
            <li>About a minute. Keep the cable in and don't transmit.</li>
            <li>Calibration and the bootloader's update area are never written.</li>
            <li>Ferrite then starts, sets up its storage and opens its first-run setup.</li>
          </ul>
        {/if}
        {#if elsewhere}{@render connect(true, false)}{/if}
        <div class="row">
          <button class="btn" onclick={close}>Cancel</button>
          {#if I.connected || elsewhere}
            <button class="btn primary" disabled={!!I.installBlock || I.running} onclick={() => I.install()}>Install Ferrite</button>
          {:else}
            <!-- The cable was let go (unplugged, or the wizard closed): connect again here, then Install. -->
            {#if bridge}<button class="btn" disabled={radio.phase !== "idle"} onclick={() => I.connect("bridge")}>Bridge</button>{/if}
            <button class="btn primary" disabled={!cableOk || radio.phase !== "idle"} onclick={() => I.connect("cable")}>Connect again…</button>
          {/if}
        </div>
      {:else if I.installStep === "running"}
        {@render progress()}
      {:else}
        <div class="err" role="alert">
          <p><strong>The install stopped.</strong> {I.errorAt === "install" ? I.error : ""}</p>
        </div>
        <div class="note" role="group" aria-label="What to do now">
          <p><strong>What to do now</strong></p>
          <ul class="notes">
            <li>The radio is most likely waiting in its bootloader (a blank screen). That's safe: calibration and your backup are untouched.</li>
            <li>Keep the cable in and press Try again: Console sends Ferrite again.</li>
            <li>If the radio doesn't answer, turn it off, hold the two lower side keys and turn it on, then try again.</li>
          </ul>
          {#if I.connected}
            <div class="row">
              <button class="btn" onclick={close}>Disconnect and close</button>
              <button class="btn primary" disabled={!!I.installBlock || I.running} onclick={() => I.install()}>Try again</button>
            </div>
            {#if I.installBlock}<p class="warn" data-k="install-block">{I.installBlock}</p>{/if}
          {:else}
            <p class="sub gap">The cable was let go: connect again, then try again.</p>
            {@render connect(true, false)}
          {/if}
        </div>
      {/if}
    {:else}
      <div class="done" role="region" aria-label="Installed">
        <p class="big">Done</p>
        <p>{I.installed ? `The radio runs Ferrite ${I.installed}.` : "The radio restarts into Ferrite. Finish the setup on the radio."}</p>
        {#if radio.phase === "connected"}<p class="sub">Console is connected to it as usual.</p>{/if}
      </div>
      <ul class="notes">
        <li>Finish the first-run setup on the radio.</li>
        <li>Keep your backup file safe. It's the way back (Firmware › Back to stock).</li>
        <li>The user guide covers every screen and key: <a href="https://manual.ferritefw.dev" target="_blank" rel="noopener">manual.ferritefw.dev ↗</a></li>
      </ul>
      <div class="row">
        <button class="btn" onclick={close}>Close</button>
        <a class="btn primary" href={home} onclick={() => onclose()}>Open Live View</a>
      </div>
    {/if}
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    justify-content: center;
    overflow-y: auto;
    padding: 16px;
    background: rgb(0 0 0 / 0.75);
  }
  .panel {
    margin: auto 0;
    width: 100%;
    max-width: 640px;
    min-height: min(560px, calc(100vh - 32px));
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 28px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--surface);
    box-shadow: var(--shadow);
  }
  .top {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  h2 {
    margin: 0;
    font-size: 18px;
  }
  h3 {
    margin: 8px 0 0;
    font-size: 16px;
  }
  .x {
    padding: 4px 10px;
  }
  .steps {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 18px;
    margin: 0;
    padding: 0 0 14px;
    border-bottom: 1px solid var(--line);
    list-style: none;
    font-size: 13px;
    color: var(--sub);
  }
  .steps li::before {
    content: "○ ";
  }
  .steps li.past::before {
    content: "✓ ";
    color: var(--green);
  }
  .steps li.on {
    color: var(--text);
    font-weight: 600;
  }
  .steps li.on::before {
    content: "● ";
    color: var(--blue);
  }
  p {
    margin: 0;
  }
  .notes {
    margin: 0;
    padding-left: 18px;
    color: var(--sub);
  }
  .notes li + li {
    margin-top: 4px;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: flex-end;
    align-items: center;
    margin-top: auto;
  }
  .gap {
    margin-top: 8px;
  }
  .note .row,
  .save .row {
    margin-top: 10px;
  }
  .sub,
  .msg {
    color: var(--sub);
  }
  .msg {
    color: var(--text);
  }
  .right {
    text-align: right;
    font-size: 13px;
  }
  .warn {
    color: var(--amber);
  }
  .good {
    color: var(--green);
  }
  .err {
    padding: 10px 12px;
    border: 1px solid var(--red);
    border-radius: 8px;
  }
  .note {
    padding: 12px 14px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--raised);
  }
  .note .notes {
    margin-top: 6px;
  }
  .warn-box {
    border-color: var(--amber);
  }
  .save {
    padding: 12px 14px;
    border: 1px solid var(--amber);
    border-radius: 8px;
  }
  .save .sub,
  .save .warn {
    margin-top: 8px;
  }
  .facts {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 4px 14px;
    margin: 0;
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
  .progress {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: auto 0;
  }
  progress {
    width: 100%;
  }
  .done {
    text-align: center;
    margin-top: 12px;
  }
  .done p + p {
    margin-top: 6px;
  }
  .big {
    font-size: 22px;
    font-weight: 600;
    color: var(--green);
  }
  a.btn {
    text-decoration: none;
  }
  @media (max-width: 520px) {
    .panel {
      padding: 20px 16px;
    }
  }
</style>
