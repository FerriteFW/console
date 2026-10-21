<script lang="ts">
  import Wordmark from "../components/Wordmark.svelte";
  import { isTauri } from "../transport/native";
  const shell = isTauri() ? "desktop app (Tauri)" : "web";
</script>

<div class="card about">
  <Wordmark size={44} />
  <p>
    Ferrite Console is the companion for Ferrite, the firmware for the Radtel RT-950 Pro: the radio's screen and
    keys from the computer now, channel programming next.
  </p>
  <dl>
    <dt>Version</dt>
    <dd>0.1.0 ({shell})</dd>
    <dt>Protocol</dt>
    <dd>Ferrite link protocol v2 (manual chapter 29), the same code as the radio's (ferrite-core, compiled to WebAssembly)</dd>
    <dt>Connections</dt>
    <dd>The programming cable (Web Serial, 115200 8N1, raised to 460800 when the radio takes it) and the radio's Bluetooth (Web Bluetooth, FFE0/FFE1)</dd>
    <dt>Never</dt>
    <dd>Transmits, writes calibration, or touches the Bluetooth module's own settings</dd>
  </dl>
  <p class="sub">Its sections follow F4HWN's UV Studio (a viewer, tools, and about), in Ferrite's own look.</p>
</div>

<style>
  .about {
    max-width: 640px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  p {
    margin: 0;
  }
  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 6px 14px;
    margin: 0;
  }
  dt {
    color: var(--sub);
  }
  dd {
    margin: 0;
  }
  .sub {
    color: var(--sub);
    font-size: 13px;
  }
</style>
