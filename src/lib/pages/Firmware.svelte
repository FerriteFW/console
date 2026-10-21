<script lang="ts">
  // Tools › Firmware Update: a Ferrite .btf into a radio already on Ferrite, over the cable. The checks and the
  // bootloader's frames are the core's (tools/btf.py and tools/flash.py, ported); the flow is firmware.svelte.ts.
  import { firmware } from "../firmware.svelte";
  import { radio } from "../radio.svelte";
  import { bridgeEnabled } from "../transport/bridge";

  let fileInput: HTMLInputElement;
  let confirming = $state(false);
  const bridge = bridgeEnabled();

  const connected = $derived(radio.phase === "connected");
  const onCable = $derived(connected && radio.kind === "cable");
  const holding = $derived(radio.phase === "updating");
  const check = $derived(firmware.check);
  const ok = $derived(!!check && check.problems.length === 0);

  async function pick(e: Event) {
    const el = e.currentTarget as HTMLInputElement;
    const f = el.files?.[0];
    el.value = "";
    confirming = false;
    if (f) await firmware.pick(f);
  }

  async function install() {
    confirming = false;
    await firmware.start();
  }

  const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
</script>

<div class="page">
  <section class="card intro">
    <h1>Firmware Update</h1>
    <ul>
      <li>For a radio that already runs Ferrite, on the cable.</li>
      <li>Console restarts the radio into its bootloader, sends the new image, and connects again.</li>
      <li>Channels and settings stay. Calibration is never touched.</li>
      <li>
        First install from stock firmware: use <code>tools/flash.py</code>. It needs the whole-flash backup first, so it stays
        a bench job.
      </li>
    </ul>
  </section>

  <section class="card" aria-label="Image file">
    <h2>1. Pick the image</h2>
    <div class="row">
      <button class="btn" disabled={firmware.running} onclick={() => fileInput.click()}>Choose .btf…</button>
      <input bind:this={fileInput} type="file" accept=".btf,.BTF" hidden aria-label="Firmware file" onchange={pick} />
      {#if firmware.fileName}<span class="fname">{firmware.fileName}</span>{/if}
    </div>
    {#if check}
      <dl class="facts" aria-label="File checks">
        <dt>Version</dt>
        <dd data-k="version">{check.version ?? "not found in the image"}</dd>
        <dt>Size</dt>
        <dd data-k="size">{kb(check.file_len)} file, {kb(check.image_len)} image</dd>
        <dt>Blocks</dt>
        <dd data-k="blocks">{check.blocks}</dd>
        <dt>CRC-32</dt>
        <dd data-k="crc">{check.crc32}</dd>
        {#if check.describe}
          <dt>Image</dt>
          <dd class="mono">{check.describe}</dd>
        {/if}
      </dl>
      {#if ok}
        <p class="good" role="region" aria-live="polite" aria-label="File check">Checks passed: a Ferrite image the bootloader will start.</p>
      {:else}
        <div class="banner" role="alert" aria-label="File refused">
          <strong>Console won't flash this file.</strong>
          <ul>
            {#each check.problems as p, i (i)}<li>{p}</li>{/each}
          </ul>
        </div>
      {/if}
    {/if}
  </section>

  <section class="card" aria-label="Install">
    <h2>2. Install</h2>
    {#if !connected && !holding}
      <p class="sub">Connect the radio over the cable first (Connect › Cable).</p>
    {:else if connected && !onCable}
      <p class="sub">Firmware Update works over the cable only. Disconnect, then connect with the cable.</p>
    {/if}

    {#if onCable && ok && firmware.stage !== "done"}
      {#if !confirming}
        <button class="btn primary" onclick={() => (confirming = true)}>Update firmware…</button>
      {:else}
        <div class="confirm" role="group" aria-label="Confirm update">
          <table>
            <thead><tr><th></th><th>Firmware</th><th>Build</th></tr></thead>
            <tbody>
              <tr><th>On the radio</th><td data-k="now">{radio.info?.firmware ?? "?"}</td><td>{radio.info?.build?.name ?? "?"}</td></tr>
              <tr><th>This file</th><td data-k="new">{check?.version ?? "?"}</td><td class="sub">(not in the file)</td></tr>
            </tbody>
          </table>
          <ul class="sub">
            <li>Keep the cable in until Console says done (about {Math.ceil((check?.blocks ?? 0) / 8)} s).</li>
            <li>Don't transmit meanwhile.</li>
          </ul>
          <div class="row">
            <button class="btn primary" onclick={install}>Install</button>
            <button class="btn" onclick={() => (confirming = false)}>Cancel</button>
          </div>
        </div>
      {/if}
    {/if}

    {#if firmware.running}
      <div class="progress-box" role="region" aria-live="polite" aria-label="Update progress">
        <p>{firmware.message}</p>
        {#if firmware.stage === "sending"}
          <progress max={firmware.blocks} value={firmware.done} aria-label="Blocks sent"></progress>
          <span class="pct">{firmware.pct}%</span>
        {/if}
      </div>
    {/if}

    {#if firmware.error}
      <div class="banner" role="alert" aria-label="Update error">{firmware.error}</div>
    {/if}

    {#if firmware.stage === "failed" && holding && !firmware.running}
      <div class="row">
        {#if firmware.canResume && ok}
          <button class="btn primary" onclick={() => firmware.resume()}>Resume</button>
        {/if}
        <button class="btn" onclick={() => firmware.release()}>Give up and disconnect</button>
      </div>
    {/if}

    {#if firmware.stage === "done" && firmware.after}
      <div class="good-box" role="region" aria-live="polite" aria-label="Update done">
        <p><strong>Done.</strong> The radio runs <span data-k="after">{firmware.after.firmware}</span>{firmware.after.build ? ` (${firmware.after.build})` : ""}.</p>
        {#if check?.version && check.version !== firmware.after.firmware}
          <p class="warn">The file said {check.version}: check the radio's About page (MENU 0 9 9).</p>
        {/if}
        {#if firmware.before}<p class="sub">Before:{firmware.before.firmware}{firmware.before.build ? ` (${firmware.before.build})` : ""}.</p>{/if}
      </div>
    {/if}
  </section>

  {#if !connected && !holding && ok}
    <section class="card" aria-label="Recover">
      <h2>Radio waiting in the bootloader?</h2>
      <p class="sub">After a failed update the radio stays in its bootloader (blank screen). Console can send the image again without connecting first.</p>
      <div class="row">
        <button class="btn" onclick={() => firmware.openAndResume("cable")} disabled={radio.available().cable !== true}>Open the cable and resume</button>
        {#if bridge}<button class="btn" onclick={() => firmware.openAndResume("bridge")}>Resume over the bridge</button>{/if}
      </div>
    </section>
  {/if}
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
    margin: 0 0 10px;
    font-size: 15px;
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
  .fname {
    font-family: var(--mono, monospace);
  }
  .facts {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 4px 14px;
    margin: 12px 0 0;
  }
  dt {
    color: var(--sub);
  }
  dd {
    margin: 0;
  }
  .mono {
    font-family: var(--mono, monospace);
    font-size: 12px;
    word-break: break-word;
  }
  .sub {
    color: var(--sub);
  }
  .good {
    color: var(--green);
    margin: 10px 0 0;
  }
  .banner {
    margin-top: 10px;
    padding: 10px 14px;
    border: 1px solid var(--red);
    border-radius: 8px;
    color: var(--red);
  }
  .banner ul {
    margin-top: 6px;
  }
  .confirm {
    border: 1px solid var(--amber);
    border-radius: 8px;
    padding: 12px 14px;
  }
  table {
    border-collapse: collapse;
    margin-bottom: 8px;
  }
  th,
  td {
    text-align: left;
    padding: 3px 14px 3px 0;
  }
  thead th {
    color: var(--sub);
    font-weight: 500;
  }
  .progress-box {
    margin-top: 10px;
  }
  .progress-box p {
    margin: 0 0 6px;
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
  .warn {
    color: var(--amber);
  }
  .good-box p {
    margin: 0 0 4px;
  }
  code {
    font-family: var(--mono, monospace);
  }
</style>
