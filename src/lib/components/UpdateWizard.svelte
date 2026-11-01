<script lang="ts">
  // Firmware Update as a focused modal (Alex, Oct 29: the wizard): Check (versions, signature) → Update (progress,
  // keep the cable in) → Done. The flow itself is firmware.svelte.ts; the image is the bundled release unless a file
  // was chosen under Advanced. It can't be closed while the radio is in the middle of it.
  import { firmware } from "../firmware.svelte";
  import { Eta, etaText } from "../eta";
  import { radio } from "../radio.svelte";
  import { signatureText } from "../signature";

  let { onclose }: { onclose: () => void } = $props();

  const check = $derived(firmware.check);
  const ok = $derived(!!check && check.problems.length === 0);
  const onCable = $derived(radio.phase === "connected" && radio.kind === "cable");
  const step = $derived(firmware.stage === "done" ? 3 : firmware.running || firmware.stage === "failed" ? 2 : 1);
  const busy = $derived(firmware.running || radio.phase === "updating");

  // Open with nothing chosen: the bundled release.
  $effect(() => {
    if (!firmware.check && firmware.bundled && !firmware.running) void firmware.useBundled();
  });

  function close() {
    if (busy) return;
    if (firmware.stage === "done") firmware.clearFile();
    onclose();
  }

  function keydown(e: KeyboardEvent) {
    if (e.key === "Escape") close();
  }
  /** Seconds left beside the percentage. */
  const eta = new Eta();
  const left = $derived(eta.left(firmware.done, firmware.blocks));
</script>

<svelte:window onkeydown={keydown} />

<div class="overlay">
  <div class="panel" role="dialog" aria-modal="true" aria-labelledby="upd-title">
    <h2 id="upd-title">Update Ferrite</h2>
    <ol class="steps" aria-label="Steps">
      {#each ["Check", "Update", "Done"] as name, i (name)}
        <li class:on={step === i + 1} class:past={step > i + 1}>{name}</li>
      {/each}
    </ol>

    {#if step === 1}
      {#if check}
        <div class="versions">
          <span data-k="now">{radio.info?.firmware ?? "?"}</span>
          <span class="arrow">→</span>
          <span class="to" data-k="new">{check.version ?? "?"}</span>
        </div>
        {#if firmware.signature}
          <p class="sig" class:signed={firmware.signature.kind === "signed"} class:bad={firmware.signature.kind === "bad"}>
            {signatureText(firmware.signature)}
          </p>
        {/if}
        {#if ok}
          <ul class="notes">
            <li>Your channels and settings stay. Calibration is never touched.</li>
            <li>About {Math.max(30, Math.ceil(check.blocks / 8))} s. Keep the cable in and don't transmit.</li>
          </ul>
        {:else}
          <div class="err" role="alert">
            <strong>Console won't install this file.</strong>
            <ul>{#each check.problems as p, i (i)}<li>{p}</li>{/each}</ul>
          </div>
        {/if}
      {:else if !firmware.error}
        <p class="sub">Getting the release ready…</p>
      {/if}
      {#if firmware.error}<div class="err" role="alert" aria-label="Update error">{firmware.error}</div>{/if}
      {#if !onCable}
        <p class="warn">{radio.phase === "connected" ? "Updates need the cable: disconnect, then connect with the cable." : "Connect the radio with the cable first."}</p>
      {/if}
      <div class="row">
        <button class="btn" onclick={close}>Cancel</button>
        <button class="btn primary" disabled={!ok || !onCable} onclick={() => firmware.start()}>Update</button>
      </div>
    {:else if step === 2}
      <p class="msg" aria-live="polite">{firmware.message || "Starting…"}</p>
      {#if firmware.stage === "sending"}
        <progress max={firmware.blocks} value={firmware.done} aria-label="Sent"></progress>
        <p class="sub">{firmware.pct}%{etaText(left)}</p>
      {/if}
      {#if firmware.running}
        <p class="warn">Keep the cable in until this says done.</p>
      {/if}
      {#if firmware.error}<div class="err" role="alert" aria-label="Update error">{firmware.error}</div>{/if}
      {#if firmware.stage === "failed" && !firmware.running}
        <p class="sub">The radio is waiting in its bootloader (a blank screen). It's safe: send the image again.</p>
        <div class="row">
          {#if radio.phase === "updating"}
            <button class="btn" onclick={() => firmware.release()}>Give up and disconnect</button>
            {#if firmware.canResume && ok}<button class="btn primary" onclick={() => firmware.resume()}>Try again</button>{/if}
          {:else}
            <button class="btn" onclick={close}>Close</button>
          {/if}
        </div>
      {/if}
    {:else}
      <div class="done" role="region" aria-label="Update done">
        <p class="big">Done</p>
        <p>The radio runs <span data-k="after">{firmware.after?.firmware ?? "the new firmware"}</span>{firmware.after?.build ? ` (${firmware.after.build})` : ""}.</p>
        {#if check?.version && firmware.after && check.version !== firmware.after.firmware}
          <p class="warn">The file said {check.version}: check the radio's About page (MENU 0 9 8).</p>
        {/if}
      </div>
      <div class="row">
        <button class="btn primary" onclick={close}>Close</button>
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
    max-width: 460px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 24px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--surface);
    box-shadow: var(--shadow);
  }
  h2 {
    margin: 0;
    font-size: 17px;
  }
  .steps {
    display: flex;
    gap: 18px;
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: 13px;
    color: var(--sub);
  }
  .steps li::before {
    content: "○ ";
  }
  .steps li.past::before {
    content: "✓ ";
  }
  .steps li.on {
    color: var(--text);
    font-weight: 600;
  }
  .steps li.on::before {
    content: "● ";
    color: var(--blue);
  }
  .versions {
    display: flex;
    gap: 14px;
    align-items: baseline;
    justify-content: center;
    font-size: 22px;
    font-weight: 600;
  }
  .arrow {
    color: var(--sub);
  }
  .to {
    color: var(--blue);
  }
  .sig {
    margin: 0;
    text-align: center;
    font-size: 13px;
    color: var(--sub);
  }
  .sig.signed {
    color: var(--green);
  }
  .sig.bad {
    color: var(--red);
  }
  .notes {
    margin: 0;
    padding-left: 18px;
    color: var(--sub);
    font-size: 13px;
  }
  .row {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
  .sub,
  .msg {
    margin: 0;
    color: var(--sub);
  }
  .msg {
    color: var(--text);
  }
  .warn {
    margin: 0;
    color: var(--amber);
    font-size: 13px;
  }
  .err {
    padding: 10px 12px;
    border: 1px solid var(--red);
    border-radius: 8px;
    font-size: 13px;
  }
  .err ul {
    margin: 6px 0 0;
    padding-left: 18px;
  }
  progress {
    width: 100%;
  }
  .done {
    text-align: center;
  }
  .done p {
    margin: 4px 0;
  }
  .big {
    font-size: 22px;
    font-weight: 600;
    color: var(--green);
  }
</style>
