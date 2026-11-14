<script lang="ts">
  import Wordmark from "../components/Wordmark.svelte";
  import { isTauri } from "../transport/native";
  import { CONSOLE_VERSION as version } from "../codeplug.svelte";
  const shell = isTauri() ? "desktop app (Tauri)" : "web";
</script>

<div class="card about">
  <Wordmark size={44} />
  <p>
    Ferrite Console is the companion app for Ferrite, firmware for the Radtel RT-950 Pro and radios built on the same hardware: the radio's screen and
    keys on the computer, its channels, zones and settings read and written, APRS messages and stations heard, and
    firmware installed and updated.
  </p>
  <p class="sub">
    How to use the radio: the <a href="https://manual.ferritefw.dev" target="_blank" rel="noopener">user guide</a>.
    Get the radio: <a href="https://www.radtels.com/products/radtel-rt-950-pro-27mhz-tx-rx-10w-walkie-talkie-am-fm-usb-lsb-cw-receive-gps-aprs-wireless-bluetooth-phone-programming-noaa-two-way-radio?ref=FERRITEFW&variant=44669996794064" target="_blank" rel="noopener sponsored">Radtel RT-950 Pro</a>.
  </p>
  <dl>
    <dt>Version</dt>
    <dd>{version} ({shell})</dd>
    <dt>Protocol</dt>
    <dd>Ferrite link protocol 1 (manual chapter 29), the same code as the radio's (ferrite-core, compiled to WebAssembly)</dd>
    <dt>Connections</dt>
    <dd>The programming cable (Web Serial, 115200 8N1, raised to 230400 when the radio takes it) and the radio's Bluetooth (Web Bluetooth, FFE0/FFE1)</dd>
    <dt>Never</dt>
    <dd>Keys the radio itself (APRS messages you send are queued for the radio to send), writes calibration, or touches the Bluetooth module's own settings</dd>
  </dl>
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
