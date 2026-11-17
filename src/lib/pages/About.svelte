<script lang="ts">
  import Wordmark from "../components/Wordmark.svelte";
  import { isTauri } from "../transport/native";
  import { CONSOLE_VERSION as version } from "../codeplug.svelte";
  import { saveDebugInfo } from "../debugdump";
  let debugNote = $state("");
  async function saveDebug() {
    debugNote = "";
    try {
      const name = await saveDebugInfo();
      if (name) debugNote = `Saved as ${name}. Attach it to your report.`;
    } catch (e) {
      debugNote = `Not saved: ${(e as Error).message}`;
    }
  }
  const shell = isTauri() ? "desktop app (Tauri)" : "web";
  // The third-party notices (tools/thirdparty.py, about 500 KB), fetched only when opened.
  let notices = $state("");
  async function openNotices(e: Event) {
    if (!(e.currentTarget as HTMLDetailsElement).open || notices) return;
    try {
      const r = await fetch("THIRD-PARTY-LICENSES.md");
      notices = r.ok ? await r.text() : "The notices didn't load.";
    } catch {
      notices = "The notices didn't load.";
    }
  }
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
    <dd>The programming cable (Web Serial, 115200 8N1 without compression; 230400 with Live View's High speed) and the radio's Bluetooth (Web Bluetooth, FFE0/FFE1)</dd>
    <dt>Never</dt>
    <dd>Keys the radio itself (APRS messages you send are queued for the radio to send), writes calibration, or touches the Bluetooth module's own settings</dd>
  </dl>
  <div class="debug">
    <button class="btn" onclick={saveDebug}>Save debug info…</button>
    <span class="sub">
      For a bug report: what Console runs on, the connection, the radio, and Console's recent log (the link's requests and answers,
      writes and errors). Save it right after the problem; if Console was closed since, the last session's log is in it too. It holds no PIN; it does name the radio's callsign and ID, and the channels a write's read back found different.
    </span>
    {#if debugNote}<p class="sub" role="status">{debugNote}</p>{/if}
  </div>
  <details ontoggle={openNotices}>
    <summary>Third-party licences</summary>
    <p class="sub">
      Console is under the PolyForm Noncommercial licence. It includes the work of others: Rust crates, the Tauri and
      Leaflet packages, the JetBrains Mono and Barlow fonts, and on Linux the system libraries the AppImage carries.
      Their licences, in full:
    </p>
    <pre class="notices">{notices || "Loading..."}</pre>
  </details>
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
  .debug {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 12px;
  }
  .debug .btn {
    flex: none;
  }
  summary {
    cursor: pointer;
    color: var(--sub);
  }
  details[open] summary {
    margin-bottom: 8px;
  }
  .notices {
    max-height: 420px;
    overflow: auto;
    font-size: 11px;
    white-space: pre-wrap;
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 10px;
    margin: 8px 0 0;
  }
  .sub {
    color: var(--sub);
    font-size: 13px;
  }
</style>
