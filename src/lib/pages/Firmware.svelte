<script lang="ts">
  // Tools › Firmware Update: a Ferrite update file (.ffw, ferrite decision 335) or a bare .btf into a radio already on
  // Ferrite, over the cable. The checks and the
  // bootloader's frames are the core's (tools/btf.py and tools/flash.py, ported); the flow is firmware.svelte.ts.
  import { firmware } from "../firmware.svelte";
  import { radio } from "../radio.svelte";
  import { signatureText } from "../signature";
  import { bridgeEnabled } from "../transport/bridge";
  import UpdateWizard from "../components/UpdateWizard.svelte";
  import ReleaseNotes from "../components/ReleaseNotes.svelte";
  import { appUpdate, CONSOLE_DOWNLOADS } from "../updates.svelte";
  import { isTauri } from "../transport/native";
  import { olderThan } from "../version";
  import { ssb } from "../ssb.svelte";
  import { untrack } from "svelte";

  let fileInput: HTMLInputElement;
  let wizard = $state(false);
  const bridge = bridgeEnabled();

  // A radio on another link protocol (decision 385) is connected for this page alone.
  const connected = $derived(radio.phase === "connected" || radio.phase === "outdated");
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
  const mine = $derived(radio.info?.firmware ?? radio.hello?.firmware ?? "");
  const latest = $derived(firmware.check?.version ?? firmware.bundled?.version ?? "");
  // A file chosen here (not the bundled release): Advanced stays open to show its checks.
  const chosen = $derived(!!firmware.fileName && firmware.fileName !== firmware.bundled?.file);
  const current = $derived(!!mine && !!latest && bare(mine).startsWith(bare(latest)));
  // Ferrite 0.9.4 and earlier could leave some radios' memory chips (Macronix) stuck mid-write; only a power-off clears
  // a chip, and an update's restart doesn't cut its power. So a radio on one of those is turned off and on first, and
  // Update waits for the owner to say so (ferrite SAFE-1.3, Nov 20, 2026).
  const needsPowerCycle = $derived(connected && !!mine && olderThan(mine, "0.9.5"));
  let powerCycled = $state(false);
  // UPD-25.1: a release older than the radio's Ferrite is refused; an older file chosen by hand is a downgrade, noted.
  const down = $derived(firmware.downgrade);

  void firmware.loadBundled();
  // UPD-30 (Alex, Nov 27, 2026): firmware updates only from the latest Console, so a radio never runs a Ferrite newer
  // than the Console that talks to it. A newer Console out (the desktop updater's or the feed's word): Update waits.
  // Offline or the feed unread: nothing known, nothing held. A failed update's recovery is never held.
  void appUpdate.check();
  const consoleFirst = $derived(appUpdate.version);

  const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;

  // INST-10.2: whether the connected radio has SSB, asked once a connection is up (and again after an update).
  let ssbInput = $state<HTMLInputElement>();
  const live = $derived(radio.phase === "connected");
  $effect(() => {
    if (live && !firmware.running) untrack(() => void ssb.refresh());
    else if (!live) ssb.forget();
  });
  async function ssbPicked(e: Event) {
    const el = e.currentTarget as HTMLInputElement;
    const f = el.files?.[0];
    el.value = "";
    if (f) await ssb.add(f);
  }
</script>

{#if wizard}<UpdateWizard onclose={() => (wizard = false)} />{/if}

<div class="page">
  <section class="card intro">
    <h1>Update Ferrite</h1>
    <dl class="facts">
      <dt>Your radio</dt>
      <dd data-k="now">{connected ? mine || "?" : "not connected"}</dd>
      <dt>{chosen && firmware.check ? "Chosen file" : "Latest"}</dt>
      <dd data-k="latest">{latest || "none in this copy of Console: choose a file under Advanced"}{!chosen && firmware.bundled?.url ? " (downloaded from ferritefw.dev)" : ""}</dd>
    </dl>
    {#if firmware.needsConsole}
      <p class="sub" data-k="needs-console">Ferrite {firmware.needsConsole} is out; it needs a newer Console. <a href={CONSOLE_DOWNLOADS} target="_blank" rel="noopener">Get it</a>.</p>
    {/if}
    {#if needsPowerCycle}
      <div class="power" role="alert" data-k="power-cycle">
        <strong>Turn the radio off and on before updating.</strong>
        <p>Ferrite {mine} can leave some radios' memory chip stuck, and only switching the radio off clears it (an update's restart doesn't). Turn the radio off with the knob, wait 10 seconds, turn it on, connect again here, then update. After the update, write your channels again.</p>
        <label><input type="checkbox" bind:checked={powerCycled} data-k="power-cycled" /> I turned the radio off for 10 seconds and back on</label>
      </div>
    {/if}
    {#if consoleFirst}
      <div class="power" role="alert" data-k="console-first">
        <strong>Update Console first.</strong>
        <p>Console {consoleFirst} is out. Ferrite updates only from the latest Console, so the radio and Console always speak the same version.{isTauri() ? "" : " On the web, reload this page."}</p>
        {#if appUpdate.installable}
          <button class="btn primary" disabled={appUpdate.busy} onclick={() => appUpdate.install()}>{appUpdate.busy ? "Updating Console…" : `Install Console ${consoleFirst} and restart`}</button>
          {#if appUpdate.error}<p class="sub">{appUpdate.error}</p>{/if}
        {:else if isTauri()}
          <a class="btn primary" href={CONSOLE_DOWNLOADS} target="_blank" rel="noopener">Download Console {consoleFirst}</a>
        {:else}
          <button class="btn primary" onclick={() => location.reload()}>Reload</button>
        {/if}
      </div>
    {/if}
    <div class="row">
      <button class="btn primary" disabled={!!consoleFirst || !latest || (!!check && !ok) || (!!down && "refuse" in down) || (needsPowerCycle && !powerCycled)} onclick={() => (wizard = true)}>{current ? "Install again…" : "Update…"}</button>
      {#if connected && current}<span class="sub">Up to date.</span>{/if}
    </div>
    {#if down}
      <p class={"refuse" in down ? "err" : "note"} role="alert" data-k="downgrade">{"refuse" in down ? down.refuse : down.note}</p>
    {/if}
    <p class="sub hint">Channels and settings stay. Over the cable only. A radio still on its stock firmware: use the <a href="#/install">Install</a> tab.</p>
  </section>

  <ReleaseNotes notes={firmware.notes} running={connected ? mine : ""} offered={latest} byHand={chosen} />

  {#if live}
    <section class="card" aria-label="SSB">
      <h2>SSB receive</h2>
      {#if ssb.held === true}
        <p data-k="ssb-held">This radio has SSB: USB, LSB and CW work in HF mode.</p>
      {:else if ssb.tooOld}
        <p data-k="ssb-held">Update Ferrite first, then you can add SSB here.</p>
      {:else if ssb.held === false}
        <p data-k="ssb-held">This radio has no SSB yet, so USB, LSB and CW are hidden in HF mode. Add it from your stock firmware file (.BTF, from the radio maker's website). Console takes the part it needs from the file, here on this computer.</p>
      {/if}
      {#if ssb.held === false && !ssb.tooOld}
        <div class="row">
          <button class="btn" disabled={!!ssb.total || firmware.running || !!radio.busy} onclick={() => ssbInput?.click()}>Add SSB…</button>
          <input bind:this={ssbInput} type="file" accept=".btf,.BTF" hidden aria-label="Stock firmware for SSB" onchange={ssbPicked} />
          {#if ssb.total}<span class="sub" data-k="ssb-progress">Sending… {Math.round((ssb.done * 100) / ssb.total)}%{radio.kind === "cable" ? "" : " (slower over Bluetooth)"}</span>{/if}
        </div>
      {/if}
      {#if ssb.notice}<p class="note" data-k="ssb-notice">{ssb.notice}</p>{/if}
      {#if ssb.error}<p class="err" role="alert" data-k="ssb-error">{ssb.error}</p>{/if}
    </section>
  {/if}

  <details class="card" aria-label="Advanced" open={chosen || undefined}>
    <summary>Advanced: install a file (.ffw or .btf)</summary>
    <div class="row">
      <button class="btn" disabled={firmware.running} onclick={() => fileInput.click()}>Choose a file…</button>
      <input bind:this={fileInput} type="file" accept=".ffw,.FFW,.btf,.BTF,.minisig" multiple hidden aria-label="Firmware file" onchange={pick} />
      {#if firmware.fileName}<span class="fname">{firmware.fileName}</span>{/if}
      {#if firmware.bundled}
        <button class="btn quiet" disabled={firmware.running} onclick={() => firmware.useBundled()}>Back to the latest release</button>
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
  .note {
    color: var(--amber);
    margin: 8px 0 0;
  }
  .err {
    color: var(--red);
    margin: 8px 0 0;
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
  .power {
    margin: 12px 0 4px;
    padding: 14px 16px;
    border: 2px solid var(--red);
    border-radius: 8px;
    background: color-mix(in srgb, var(--red) 12%, transparent);
  }
  .power strong {
    display: block;
    color: var(--red);
    font-size: 17px;
  }
  .power p {
    margin: 6px 0 10px;
  }
  .power label {
    font-weight: 600;
    cursor: pointer;
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
