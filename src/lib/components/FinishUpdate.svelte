<script lang="ts">
  // Finish the update (UPD-16, LINK-62) as a focused modal: the radio's firmware stores a new layout and its data
  // waits in the old one (the radio shows D25). Confirm → back up → move → the radio restarts → done. The flow is
  // migrate.svelte.ts; it can't be closed while it runs.
  import { LAYOUT_MOVING, migrate } from "../migrate.svelte";
  import { radio } from "../radio.svelte";
  import MigrateProgress from "./MigrateProgress.svelte";

  let { onclose }: { onclose: () => void } = $props();
  let fileInput: HTMLInputElement;

  const l = $derived(radio.hello?.layouts ?? null);
  const onCable = $derived(radio.phase === "connected" && radio.kind === "cable");
  const step = $derived(migrate.stage === "done" ? 3 : migrate.running || migrate.stage === "failed" ? 2 : 1);

  void migrate.lookKept();

  function close() {
    if (migrate.running) return;
    migrate.reset();
    onclose();
  }
  function keydown(e: KeyboardEvent) {
    if (e.key === "Escape") close();
  }
  async function pick(e: Event) {
    const el = e.currentTarget as HTMLInputElement;
    const f = el.files?.[0];
    el.value = "";
    if (f) await migrate.pick(f);
  }
</script>

<svelte:window onkeydown={keydown} />

<div class="overlay">
  <div class="panel" role="dialog" aria-modal="true" aria-labelledby="fin-title">
    <h2 id="fin-title">Finish the update</h2>
    <ol class="steps" aria-label="Steps">
      {#each ["Confirm", "Move", "Done"] as name, i (name)}
        <li class:on={step === i + 1} class:past={step > i + 1}>{name}</li>
      {/each}
    </ol>

    {#if step === 1}
      {#if l?.chip === LAYOUT_MOVING}
        <p>
          The radio's data is part way through a move from an earlier try (stopped before its last step), and the radio waits on its "Finish the update" page.
          Console finishes it from the backup made when that try began: this computer's copy, or the backup file.
        </p>
      {:else}
        <p>
          The radio runs Ferrite {radio.info?.firmware ?? ""}, which keeps its data in a new layout{l ? ` (layout ${l.firmware})` : ""}. Your channels, zones, settings
          and lists are still in the old one{l && l.chip !== l.firmware ? ` (layout ${l.chip})` : ""}, untouched: the radio waits on its "Finish the update" page.
        </p>
      {/if}
      <ul class="notes">
        <li>Console backs everything up first, then moves it and restarts the radio. About a minute.</li>
        <li>A zone holds 256 channels now: a longer one is split ("Repeaters 2" takes the rest).</li>
        <li>Keep the cable in. If anything stops it, nothing is lost: Console starts again from its backup.</li>
      </ul>
      {#if migrate.keptFrom}<p class="sub" data-k="kept">Console has this radio's backup from {new Date(migrate.keptFrom).toLocaleString()}: it starts from that.</p>{/if}
      {#if migrate.picked}<p class="sub" data-k="picked">Starting from {migrate.picked.name}.</p>{/if}
      <label class="opt"><input type="checkbox" bind:checked={migrate.saveFile} /> Save the backup to a file too (Console keeps a copy either way)</label>
      <details>
        <summary>Advanced</summary>
        <p class="sub">On another computer, or after clearing Console's data: start from the backup file saved earlier.</p>
        <button class="btn quiet" onclick={() => fileInput.click()}>Use a saved backup…</button>
        <input bind:this={fileInput} type="file" accept=".bin" hidden aria-label="Backup file" onchange={pick} />
      </details>
      {#if migrate.error}<div class="err" role="alert">{migrate.error}</div>{/if}
      {#if !onCable}
        <p class="warn">{radio.phase === "connected" ? "This needs the cable: disconnect, then connect with the cable." : "Connect the radio with the cable first."}</p>
      {/if}
      <div class="row">
        <button class="btn" onclick={close}>Not now</button>
        <button class="btn primary" disabled={!onCable} onclick={() => migrate.start()}>Finish the update</button>
      </div>
    {:else if step === 2}
      <MigrateProgress />
      {#if migrate.stage === "failed"}
        <div class="row">
          <button class="btn" onclick={close}>Close</button>
          <button class="btn primary" disabled={!onCable} onclick={() => migrate.start()}>Try again</button>
        </div>
      {/if}
    {:else}
      <div class="done" role="region" aria-label="Update finished">
        <p class="big">Done</p>
      </div>
      <MigrateProgress />
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
    max-width: 500px;
    display: flex;
    flex-direction: column;
    gap: 14px;
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
  p {
    margin: 0;
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
  .notes {
    margin: 0;
    padding-left: 18px;
    color: var(--sub);
    font-size: 13px;
  }
  .opt {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    font-size: 13px;
    color: var(--sub);
  }
  details {
    font-size: 13px;
  }
  details p {
    margin: 6px 0;
  }
  .sub {
    color: var(--sub);
    font-size: 13px;
  }
  .warn {
    color: var(--amber);
    font-size: 13px;
  }
  .err {
    padding: 10px 12px;
    border: 1px solid var(--red);
    border-radius: 8px;
    font-size: 13px;
  }
  .row {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
  .big {
    font-size: 22px;
    font-weight: 600;
    color: var(--green);
  }
</style>
