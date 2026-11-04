<script lang="ts">
  // Tools › Firmware Update: a Ferrite update file (.ffw, ferrite decision 335) or a bare .btf into a radio already on
  // Ferrite, over the cable. The checks and the
  // bootloader's frames are the core's (tools/btf.py and tools/flash.py, ported); the flow is firmware.svelte.ts.
  import { firmware } from "../firmware.svelte";
  import { radio } from "../radio.svelte";
  import { signatureText } from "../signature";
  import { bridgeEnabled } from "../transport/bridge";
  import UpdateWizard from "../components/UpdateWizard.svelte";

  let fileInput: HTMLInputElement;
  let wizard = $state(false);
  const bridge = bridgeEnabled();

  const connected = $derived(radio.phase === "connected");
  const onCable = $derived(connected && radio.kind === "cable");
  const holding = $derived(radio.phase === "updating");
  const check = $derived(firmware.check);
  const ok = $derived(!!check && check.problems.length === 0);

  async function pick(e: Event) {
    const el = e.currentTarget as HTMLInputElement;
    const files = Array.from(el.files ?? []);
    el.value = "";
    if (files.length) await firmware.pick(files);
  }

  // An update under way (or stuck in the bootloader) always shows in the wizard.
  $effect(() => {
    if (firmware.running || (firmware.stage === "failed" && holding)) wizard = true;
  });
  const bare = (v: string) => v.trim().replace(/^v/i, "");
  const mine = $derived(radio.info?.firmware ?? "");
  const latest = $derived(firmware.check?.version ?? firmware.bundled?.version ?? "");
  // A file chosen here (not the bundled release): Advanced stays open to show its checks.
  const chosen = $derived(!!firmware.fileName && firmware.fileName !== firmware.bundled?.file);
  const current = $derived(!!mine && !!latest && bare(mine).startsWith(bare(latest)));

  void firmware.loadBundled();

  const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
</script>

{#if wizard}<UpdateWizard onclose={() => (wizard = false)} />{/if}

<div class="page">
  <section class="card intro">
    <h1>Update Ferrite</h1>
    <dl class="facts">
      <dt>Your radio</dt>
      <dd data-k="now">{connected ? mine || "?" : "not connected"}</dd>
      <dt>{chosen && firmware.check ? "Chosen file" : "Latest"}</dt>
      <dd data-k="latest">{latest || "none in this copy of Console: choose a file under Advanced"}</dd>
    </dl>
    <div class="row">
      <button class="btn primary" disabled={!latest || (!!check && !ok)} onclick={() => (wizard = true)}>{current ? "Install again…" : "Update…"}</button>
      {#if connected && current}<span class="sub">Up to date.</span>{/if}
    </div>
    <p class="sub hint">Channels and settings stay. Over the cable only. A radio still on its stock firmware: use the <a href="#/install">Install</a> tab.</p>
  </section>

  <details class="card" aria-label="Advanced" open={chosen || undefined}>
    <summary>Advanced: install a file (.ffw or .btf)</summary>
    <div class="row">
      <button class="btn" disabled={firmware.running} onclick={() => fileInput.click()}>Choose a file…</button>
      <input bind:this={fileInput} type="file" accept=".ffw,.FFW,.btf,.BTF,.minisig" multiple hidden aria-label="Firmware file" onchange={pick} />
      {#if firmware.fileName}<span class="fname">{firmware.fileName}</span>{/if}
      {#if firmware.bundled}
        <button class="btn quiet" disabled={firmware.running} onclick={() => firmware.useBundled()}>Back to the bundled release</button>
      {/if}
    </div>
    <p class="sub hint">A .ffw (a release: the firmware and its SPI parts, signed inside) installs whole. A bare .btf: pick its .minisig with it. Update then installs this file.</p>
    <label class="opt"><input type="checkbox" checked={firmware.devUnsigned} disabled={firmware.running} onchange={(e) => firmware.setDevUnsigned((e.currentTarget as HTMLInputElement).checked)} aria-label="Allow unsigned files" /> Allow unsigned files (developer: your own builds of Ferrite)</label>
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
        {#if firmware.signature}
          <dt>Signature</dt>
          <dd data-k="signature" class:signed={firmware.signature.kind === "signed"} class:bad={firmware.signature.kind === "bad"}>
            {firmware.signature.kind === "bad" ? "Doesn't verify" : signatureText(firmware.signature)}
          </dd>
        {/if}
        {#if firmware.ffwSummary}
          <dt>SPI parts</dt>
          <dd data-k="parts">{firmware.ffwSummary.parts.map((p) => `${p.file.replace(/^spi\//, "")} (${kb(p.size)})`).join(", ") || "none"}</dd>
        {/if}
        {#if check.describe}
          <dt>Image</dt>
          <dd class="mono">{check.describe}</dd>
        {/if}
      </dl>
      {#if !ok}
        <div class="banner" role="alert" aria-label="File refused">
          <strong>Console won't flash this file.</strong>
          <ul>
            {#each check.problems as p, i (i)}<li>{p}</li>{/each}
          </ul>
        </div>
      {/if}
    {/if}
    {#if firmware.error && !wizard}<div class="banner" role="alert" aria-label="Update error">{firmware.error}</div>{/if}
  </details>

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
  .opt {
    display: flex;
    gap: 6px;
    align-items: center;
    margin-top: 8px;
    color: var(--sub);
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
  .hint {
    margin: 6px 0 0;
    font-size: 13px;
  }
  dd.signed {
    color: var(--green);
  }
  dd.bad {
    color: var(--red);
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
  summary {
    cursor: pointer;
    color: var(--sub);
  }
  details[open] summary {
    margin-bottom: 8px;
  }
</style>
