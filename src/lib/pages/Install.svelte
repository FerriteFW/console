<script lang="ts">
  // Firmware › Install: a radio on Radtel's firmware to Ferrite (decision 261). The steps are the wizard
  // (InstallWizard.svelte), the flow install.svelte.ts; here only the start and the images under Advanced.
  // `#install` (focus) opens the wizard at once. Back to stock is its own tab (Restore.svelte).
  import { install as I } from "../install.svelte";
  import { signatureText } from "../signature";
  import InstallWizard from "../components/InstallWizard.svelte";

  let { focus = false }: { focus?: boolean } = $props();
  void I.load();

  let wizard = $state(false);
  // Work under way (the cable held, a backup taken, the radio busy) always shows in the wizard.
  const started = $derived(I.connected || I.backupStep !== "idle" || I.installStep !== "idle");
  $effect(() => {
    if (focus || I.running) wizard = true;
  });

  function closed() {
    wizard = false;
    if (focus) location.hash = "#/install";
  }

  async function picked(kind: "ferrite" | "reader", e: Event) {
    const el = e.currentTarget as HTMLInputElement;
    const files = Array.from(el.files ?? []);
    el.value = "";
    if (files.length) await I.pickFile(kind, files);
  }
</script>

{#if wizard}<InstallWizard onclose={closed} />{/if}

<div class="page">
  <section class="card intro">
    <h1>Install Ferrite</h1>
    <p>Takes a radio still on Radtel's firmware to Ferrite over the programming cable: Console backs up the whole radio first, and nothing is written until you have saved that backup.</p>
    <div class="row">
      <button class="btn primary" onclick={() => (wizard = true)}>{started && I.installStep !== "done" ? "Continue install…" : "Start install…"}</button>
    </div>
    <p class="sub">Already on Ferrite? Use the <a href="#/firmware">Update</a> tab. To take Ferrite off a radio, see <a href="#/restore">Back to stock</a>.</p>
  </section>

  <details class="card advanced">
    <summary>Advanced</summary>
    <div class="adv">
      <div>
        <h3>Ferrite image</h3>
        <p class="sub">Use a file instead of the release included with Console. Pick its .minisig with it to check Ferrite's signature.</p>
        <label class="btn">Use a file…<input type="file" accept=".btf,.BTF,.minisig" multiple hidden aria-label="Ferrite file" onchange={(e) => picked("ferrite", e)} /></label>
        {#if I.ferrite && I.ferriteCheck}
          <p class="sub" data-k="release">Ferrite {I.ferriteCheck.version ?? "(no version)"} ({I.ferriteSource === "bundled" ? "included" : I.ferrite.name}){#if I.ferriteSignature && I.ferriteSignature.kind !== "bad"}. {signatureText(I.ferriteSignature)}{/if}</p>
        {:else if I.releaseError}
          <p class="warn">{I.releaseError}</p>
        {/if}
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
  h1 {
    margin: 0 0 8px;
    font-size: 18px;
  }
  h3 {
    margin: 0 0 4px;
    font-size: 13px;
  }
  p {
    margin: 6px 0;
  }
  ul {
    margin: 0;
    padding-left: 18px;
  }
  .row {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
    margin: 12px 0;
  }
  .warn {
    color: var(--amber);
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
    .adv {
      grid-template-columns: 1fr;
    }
  }
</style>
