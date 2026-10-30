<script lang="ts">
  // The welcome on every visit (as NeonPlug's start-up): Console's first question is which way to reach the radio.
  // Open while nothing is connected and the visitor hasn't closed it; it closes itself once a radio answers. The
  // bar at the top still connects and disconnects as before.
  import { radio } from "../radio.svelte";
  import type { TransportKind } from "../transport";
  import { DEV_TOOLS } from "../devtools";
  import Wordmark from "./Wordmark.svelte";
  import NativePicker from "./NativePicker.svelte";
  import { picker } from "../picker.svelte";
  import { isTauri } from "../transport/native";

  let { onclose }: { onclose: () => void } = $props();

  const avail = $derived(radio.available());
  let pin = $state("");

  const ways: { kind: TransportKind; name: string; line: string }[] = [
    { kind: "cable", name: "Cable", line: "The programming cable. Everything works over it, firmware updates too." },
    { kind: "bluetooth", name: "Bluetooth", line: "No cable: Live View, channels, settings and APRS." },
    ...(DEV_TOOLS ? [{ kind: "demo" as TransportKind, name: "Demo radio", line: "A simulated radio (developer builds)." }] : []),
  ];

  // A cable that gets no answer is most often a radio still on Radtel's firmware.
  const noAnswer = $derived(/no answer/i.test(radio.error));

  function sendPin(e: SubmitEvent) {
    e.preventDefault();
    void radio.submitPin(pin);
    pin = "";
  }

  function install() {
    radio.error = "";
    location.hash = "#/install";
    onclose();
  }

  function keydown(e: KeyboardEvent) {
    if (e.key === "Escape" && radio.phase === "idle") onclose();
  }
</script>

<svelte:window onkeydown={keydown} />

<div class="overlay">
  <div class="panel" role="dialog" aria-modal="true" aria-labelledby="connect-title">
    <div class="head">
      <Wordmark size={40} />
      <p class="sub">The companion app for Ferrite radios</p>
    </div>

    {#if radio.phase === "pin"}
      <h2 id="connect-title">The radio asks for its PIN</h2>
      <form class="pin" onsubmit={sendPin}>
        <input aria-label="PIN" type="password" inputmode="numeric" pattern="[0-9]{'{4,6}'}" maxlength="6" bind:value={pin} autocomplete="off" />
        <button class="btn primary" type="submit">Unlock</button>
        <button class="btn" type="button" onclick={() => radio.disconnect()}>Cancel</button>
      </form>
      {#if radio.pinError}<p class="err" role="alert">{radio.pinError}</p>{/if}
    {:else if isTauri() && picker.kind}
      <!-- The desktop app: the ports or radios in place of the two ways (Cancel goes back to them). -->
      <NativePicker inline />
    {:else}
      <h2 id="connect-title">Connect your radio</h2>
      <div class="ways">
        {#each ways as w (w.kind)}
          {@const ok = avail[w.kind] === true}
          <button class="way" class:primary={w.kind === "cable"} disabled={!ok || radio.phase === "connecting"} onclick={() => radio.connect(w.kind)}>
            <span class="name">{w.name}</span>
            <span class="line">{ok ? w.line : String(avail[w.kind])}</span>
          </button>
        {/each}
      </div>
      {#if radio.phase === "connecting"}<p class="busy" role="status">Connecting…</p>{/if}
      {#if radio.error}
        <div class="err" role="alert">
          <p>{radio.error}</p>
          {#if noAnswer}<p>Still on its stock firmware? <button class="link" onclick={install}>Install Ferrite</button> first.</p>{/if}
        </div>
      {/if}
    {/if}

    <div class="more">
      <p>New radio, still on its stock firmware? <button class="link" onclick={install}>Install Ferrite</button></p>
      <p><a href="https://manual.ferritefw.dev" target="_blank" rel="noopener">User guide ↗</a></p>
    </div>

    {#if radio.phase === "idle"}
      <button class="btn quiet skip" onclick={onclose}>Look around without a radio</button>
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
    max-width: 440px;
    display: flex;
    flex-direction: column;
    gap: 18px;
    padding: 28px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--surface);
    box-shadow: var(--shadow);
  }
  .head {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    text-align: center;
  }
  .sub {
    margin: 0;
    color: var(--sub);
    font-size: 13px;
    text-wrap: balance;
  }
  h2 {
    margin: 0;
    font-size: 16px;
    text-align: center;
  }
  .ways {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .way {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    padding: 14px 16px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--raised);
    color: var(--text);
    text-align: left;
    cursor: pointer;
    font: inherit;
  }
  .way:hover:not(:disabled) {
    border-color: var(--blue);
  }
  .way.primary {
    border-color: var(--blue);
  }
  .way:disabled {
    cursor: default;
    opacity: 0.7;
  }
  .way .name {
    font-size: 17px;
    font-weight: 600;
  }
  .way.primary .name {
    color: var(--blue);
  }
  .way .line {
    color: var(--sub);
    font-size: 13px;
  }
  .busy {
    margin: 0;
    text-align: center;
    color: var(--sub);
  }
  .err {
    padding: 10px 12px;
    border: 1px solid var(--red);
    border-radius: 8px;
    font-size: 13px;
  }
  .err p {
    margin: 0;
  }
  .err p + p {
    margin-top: 6px;
  }
  .pin {
    display: flex;
    gap: 8px;
    justify-content: center;
  }
  .pin input {
    width: 8em;
  }
  .more {
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: center;
    font-size: 13px;
    color: var(--sub);
  }
  .more p {
    margin: 0;
    text-align: center;
    text-wrap: balance;
  }
  .link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--blue);
    font: inherit;
    cursor: pointer;
    text-decoration: underline;
  }
  .skip {
    align-self: center;
  }
</style>
