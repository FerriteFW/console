<script lang="ts">
  import { debugLines } from "./lib/debuglog";
  import { untrack } from "svelte";
  // The shell: the sidebar (the jobs, then More), the connection bar,
  // and the page. Pages by hash (#/live, #/about, ...) so a reload stays put.
  import ConnectionBar from "./lib/components/ConnectionBar.svelte";
  import ConnectModal from "./lib/components/ConnectModal.svelte";
  import NativePicker from "./lib/components/NativePicker.svelte";
  import { isTauri } from "./lib/transport/native";
  import { DEV_TOOLS } from "./lib/devtools";
  import Wordmark from "./lib/components/Wordmark.svelte";
  import LiveView from "./lib/pages/LiveView.svelte";
  import About from "./lib/pages/About.svelte";
  import Channels from "./lib/pages/Channels.svelte";
  import Terminal from "./lib/pages/Terminal.svelte";
  import Settings from "./lib/pages/Settings.svelte";
  import Firmware from "./lib/pages/Firmware.svelte";
  import Install from "./lib/pages/Install.svelte";
  import Restore from "./lib/pages/Restore.svelte";
  import { install } from "./lib/install.svelte";
  import { firmware } from "./lib/firmware.svelte";
  import { migrate } from "./lib/migrate.svelte";
  import FinishUpdate from "./lib/components/FinishUpdate.svelte";
  import { settings } from "./lib/settings.svelte";
  import { channels } from "./lib/channels.svelte";
  import { library } from "./lib/library.svelte";
  import ActivityLog from "./lib/pages/ActivityLog.svelte";
  import Videos from "./lib/pages/Videos.svelte";
  import { devOpts } from "./lib/devopts.svelte";
  import AprsHeard from "./lib/pages/AprsHeard.svelte";
  import AprsMessages from "./lib/pages/AprsMessages.svelte";
  import AprsMap from "./lib/pages/AprsMap.svelte";
  import AprsSettings from "./lib/pages/AprsSettings.svelte";
  import AprsContacts from "./lib/pages/AprsContacts.svelte";
  import AprsQuick from "./lib/pages/AprsQuick.svelte";
  import AprsWaypoints from "./lib/pages/AprsWaypoints.svelte";
  import DtmfMemories from "./lib/pages/DtmfMemories.svelte";
  import Satellites from "./lib/pages/Satellites.svelte";
  import { satellites } from "./lib/satellites.svelte";
  import { lists } from "./lib/lists.svelte";
  import { loadCore, P } from "./lib/core";
  import { radio } from "./lib/radio.svelte";
  import { aprs } from "./lib/aprs.svelte";
  import { aprsSettings } from "./lib/aprsSettings.svelte";
  import { contacts } from "./lib/contacts.svelte";
  import { activity } from "./lib/activity.svelte";
  import { route } from "./lib/route.svelte";

  // The sidebar: the jobs first, then More. A section with `tabs` covers several pages, shown as tabs above them
  // (Radio Settings, APRS, Firmware); its link opens the first.
  type Page = { id: string; name: string; soon?: string };
  type Section = { id: string; name: string; tabs?: Page[] };
  const sections: Section[] = [
    { id: "live", name: "Live View" },
    { id: "channels", name: "Channels & Zones" },
    {
      id: "settings",
      name: "Radio Settings",
      tabs: [
        { id: "settings", name: "Settings" },
        { id: "settings-dtmf", name: "DTMF memories" },
      ],
    },
    {
      id: "aprs",
      name: "APRS",
      tabs: [
        { id: "aprs-messages", name: "Messages" },
        { id: "aprs-quick", name: "Quick messages" },
        { id: "aprs-heard", name: "Heard stations" },
        { id: "aprs-map", name: "Map" },
        { id: "aprs-waypoints", name: "Waypoints" },
        { id: "aprs-contacts", name: "Contacts" },
        { id: "aprs-settings", name: "Settings" },
      ],
    },
    { id: "satellites", name: "Satellites" },
    {
      id: "firmware",
      name: "Firmware",
      tabs: [
        { id: "firmware", name: "Update" },
        { id: "install", name: "Install" },
        { id: "restore", name: "Back to stock" },
      ],
    },
  ];
  const more: Page[] = [
    { id: "activity", name: "Event Log" },
    { id: "terminal", name: "Terminal" },
    { id: "videos", name: "Videos" },
    { id: "about", name: "About" },
  ];
  const all: Page[] = [...sections.flatMap((x) => x.tabs ?? [{ id: x.id, name: x.name }]), ...more];
  // Decision 347: a user build has no line commands, so no Terminal while one is connected (HELLO's LINE_CMDS).
  const moreShown = $derived(
    more.filter((p) => p.id !== "terminal" || !radio.connectedLink || (radio.connectedLink.caps & P.caps.LINE_CMDS) !== 0),
  );
  const sectionOf = (id: string) => sections.find((x) => x.id === id || x.tabs?.some((t) => t.id === id));
  const hrefOf = (x: Section) => `#/${x.tabs ? x.tabs[0].id : x.id}`;

  let navOpen = $state(false);
  /** Finish the update's dialog (UPD-16). */
  let finishing = $state(false);
  // Each connection: whether Console holds a copy of this radio's old data from a try that was cut after writing
  // (the radio says 255, half moved, until the stamp: decision 339; the banner shows).
  $effect(() => {
    if (radio.phase === "connected" && !migrate.running) void migrate.lookKept();
  });
  // SAT-21: each connection, a radio's satellites refreshed when the list is newer (Keep satellites up to date).
  $effect(() => {
    const link = radio.connectedLink;
    if (link && !migrate.needed && !migrate.running) untrack(() => void satellites.connected(link));
  });
  $effect(() => {
    if (!satellites.toast) return;
    const t = setTimeout(() => (satellites.toast = ""), 12_000);
    return () => clearTimeout(t);
  });
  let coreError = $state("");
  const page = $derived(all.find((p) => p.id === route.id)?.id ?? "live");
  const section = $derived(sectionOf(page));
  // `#install` (no slash): the Install wizard alone, for setting up a new radio (ferritefw.dev/install); closing it
  // goes to the Install tab.
  let focus = $state(location.hash === "#install");
  $effect(() => {
    const f = () => (focus = location.hash === "#install");
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  });

  // LINK-11: a page closed while connected puts the cable back at 115200 (best effort).
  $effect(() => {
    const off = () => radio.releaseNow();
    window.addEventListener("pagehide", off);
    return () => window.removeEventListener("pagehide", off);
  });

  loadCore().catch((e) => (coreError = `The core didn't load: ${e.message}`));

  // ?demo connects the demo radio at once; ?demo&press=MENU,DOWN then presses keys (NAME:long for a long one), one
  // every 300 ms: for trying the UI and for scripted checks. window.ferrite is the same for browser automation.
  const params = new URLSearchParams(location.search);
  (window as unknown as { ferrite: unknown }).ferrite = { radio, channels, library, settings, firmware, install, aprs, aprsSettings, activity, contacts, lists, migrate, satellites, debugLines, devOpts };
  /** The sidebar's "N unwritten": the edits each section holds that aren't on the radio yet. */
  const unwritten = (id: string) =>
    id === "channels" ? channels.pending : id === "settings" ? settings.dirty.size + lists.dtmf.pending : id === "aprs" ? lists.quick.pending + lists.waypoints.pending : 0;
  if (DEV_TOOLS && params.has("demo")) {
    void radio.connect("demo").then(async () => {
      for (const k of (params.get("press") ?? "").split(",").filter(Boolean)) {
        await new Promise((r) => setTimeout(r, 300));
        const [name, how] = k.split(":");
        await radio.press(name, how === "long");
      }
    });
  }


  // The welcome (ConnectModal) on every visit, until a radio connects or the visitor closes it.
  let welcome = $state(!params.has("demo") && location.hash !== "#install");
  let closedByConnect = false;
  $effect(() => {
    const up = radio.phase === "connected" || radio.phase === "outdated" || radio.phase === "updating";
    // Closed as soon as the port or radio is open (Live View says "Connecting…" meanwhile); a connect that then
    // fails before it's up brings the welcome back with the error.
    if (up) closedByConnect = false;
    if (welcome && (up || (radio.phase === "connecting" && radio.opened))) {
      welcome = false;
      closedByConnect = !up;
    } else if (closedByConnect && radio.phase === "idle" && radio.error) {
      welcome = true;
      closedByConnect = false;
    }
  });
</script>

{#if focus}
  <div class="focus-shell">
    <div class="brand focus-brand"><Wordmark /></div>
    {#if coreError}<div class="banner">{coreError}</div>{/if}
    <main><Install focus /></main>
  </div>
{:else}
{#if welcome}<ConnectModal onclose={() => (welcome = false)} />{/if}
<div class="shell" class:nav-open={navOpen}>
  <aside class="side">
    <div class="brand"><Wordmark /></div>
    <nav aria-label="Sections">
      {#each sections as x (x.id)}
        <a href={hrefOf(x)} class:active={section?.id === x.id} aria-current={section?.id === x.id ? "page" : undefined} onclick={() => (navOpen = false)}>
          <span>{x.name}</span>
          {#if unwritten(x.id)}<span class="badge" title="Changes not written to the radio yet">{unwritten(x.id)} unwritten</span>{/if}
        </a>
      {/each}
      <div class="label">More</div>
      {#each moreShown as p (p.id)}
        <a href={`#/${p.id}`} class:active={p.id === page} aria-current={p.id === page ? "page" : undefined} onclick={() => (navOpen = false)}>
          <span>{p.name}</span>
        </a>
      {/each}
    </nav>
    <div class="side-foot">
      <a class="guide" href="https://manual.ferritefw.dev" target="_blank" rel="noopener">User guide ↗</a>
    </div>
  </aside>

  <div class="main">
    <header>
      <button class="btn quiet menu-btn" aria-label="Sections" onclick={() => (navOpen = !navOpen)}>☰</button>
      <ConnectionBar />
    </header>
    {#if coreError}<div class="banner">{coreError}</div>{/if}
    {#if (migrate.needed && radio.phase === "connected" && !firmware.running) || migrate.running}
      <!-- UPD-16: the radio's data waits in the old layout (D25 on the radio); LINK-62's move from here. -->
      <div class="banner finish" role="alert" aria-label="Finish the update">
        <span>The radio's channels and settings are waiting in the old layout. Console moves them to the new one (a backup first).</span>
        <button class="btn primary" onclick={() => (finishing = true)}>Finish the update…</button>
      </div>
    {/if}
    {#if finishing}<FinishUpdate onclose={() => (finishing = false)} />{/if}
    <main>
      {#if section?.tabs}
        <div class="tabs" role="tablist" aria-label={section.name}>
          {#each section.tabs as t (t.id)}
            <a role="tab" href={`#/${t.id}`} class:active={t.id === page} aria-selected={t.id === page}>{t.name}</a>
          {/each}
        </div>
      {/if}
      {#if page === "live"}
        <LiveView />
      {:else if page === "channels"}
        <Channels />
      {:else if page === "terminal"}
        <Terminal />
      {:else if page === "settings"}
        <Settings />
      {:else if page === "firmware"}
        <Firmware />
      {:else if page === "install"}
        <Install />
      {:else if page === "restore"}
        <Restore />
      {:else if page === "about"}
        <About />
      {:else if page === "activity"}
        <ActivityLog />
      {:else if page === "videos"}
        <Videos />
      {:else if page === "aprs-messages"}
        <AprsMessages />
      {:else if page === "aprs-heard"}
        <AprsHeard />
      {:else if page === "aprs-map"}
        <AprsMap />
      {:else if page === "aprs-settings"}
        <AprsSettings />
      {:else if page === "aprs-contacts"}
        <AprsContacts />
      {:else if page === "aprs-quick"}
        <AprsQuick />
      {:else if page === "aprs-waypoints"}
        <AprsWaypoints />
      {:else if page === "settings-dtmf"}
        <DtmfMemories />
      {:else if page === "satellites"}
        <Satellites />
      {/if}
    </main>
  </div>
</div>
{/if}

{#if satellites.toast}
  <div class="toast" aria-live="polite" data-sat-toast>
    <span>{satellites.toast}</span>
    <a href="#/satellites" onclick={() => (satellites.toast = "")}>Show</a>
    <button class="x" aria-label="Dismiss" onclick={() => (satellites.toast = "")}>✕</button>
  </div>
{/if}

<!-- The desktop app's port and radio picker, last so it sits over every wizard; inside the welcome while that's open. -->
{#if isTauri() && (focus || !welcome)}<NativePicker />{/if}

<style>
  .toast {
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 25;
    display: flex;
    align-items: center;
    gap: 10px;
    width: max-content;
    max-width: calc(100vw - 32px);
    padding: 8px 10px 8px 14px;
    border: 1px solid var(--blue);
    border-radius: 10px;
    background: var(--toast);
    box-shadow: var(--shadow);
    font-size: 13px;
  }
  /* A page's own notice (Channels' or a list's Undo) sits at the same place: this one moves up above it, so
     neither covers the other's buttons. */
  :global(body:has(.toast[aria-live]:not([data-sat-toast]))) .toast {
    bottom: 76px;
  }
  .x {
    background: none;
    border: none;
    color: var(--sub);
    cursor: pointer;
    padding: 4px 6px;
    border-radius: 6px;
  }
  .focus-shell {
    min-height: 100vh;
    padding: 20px 16px;
  }
  .focus-brand {
    max-width: 760px;
    margin: 0 auto 16px;
  }
  .shell {
    display: grid;
    grid-template-columns: 232px 1fr;
    min-height: 100vh;
  }
  .side {
    background: var(--surface);
    border-right: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    padding: 18px 14px;
    gap: 22px;
    position: sticky;
    top: 0;
    height: 100vh;
  }
  .brand {
    padding: 0 6px;
  }
  nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  nav .label {
    padding: 18px 8px 6px;
    font-size: 11px;
    color: var(--sub);
  }
  nav a {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 10px;
    border-radius: 7px;
    color: var(--text);
    text-decoration: none;
  }
  nav a:hover {
    background: var(--raised);
  }
  nav a.active {
    background: var(--blue);
    color: var(--blue-fg);
    font-weight: 700;
  }
  .badge {
    font-size: 11px;
    font-weight: 600;
    padding: 0 6px;
    border-radius: 999px;
    background: var(--amber);
    color: var(--bg);
    white-space: nowrap;
  }
  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 16px;
    border-bottom: 1px solid var(--line);
  }
  .tabs a {
    padding: 8px 12px;
    margin-bottom: -1px;
    border-bottom: 2px solid transparent;
    color: var(--sub);
    text-decoration: none;
  }
  .tabs a:hover {
    color: var(--text);
  }
  .tabs a.active {
    color: var(--text);
    border-bottom-color: var(--blue);
    font-weight: 600;
  }
  .side-foot {
    margin-top: auto;
    color: var(--dim);
    font-size: 11px;
    padding: 0 8px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .side-foot .guide {
    font-size: 13px;
  }
  .main {
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 20px;
    border-bottom: 1px solid var(--line);
    background: var(--bg);
    position: sticky;
    top: 0;
    z-index: 5;
  }
  .menu-btn {
    display: none;
  }
  main {
    padding: 20px;
  }
  .banner {
    margin: 12px 20px 0;
    padding: 10px 14px;
    border: 1px solid var(--red);
    border-radius: 8px;
    color: var(--red);
  }
  .banner.finish {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
    justify-content: space-between;
    border-color: var(--amber);
    color: var(--text);
  }
  @media (max-width: 860px) {
    .shell {
      grid-template-columns: 1fr;
    }
    .side {
      position: fixed;
      z-index: 10;
      width: 240px;
      transform: translateX(-100%);
      transition: transform 0.15s;
    }
    .nav-open .side {
      transform: none;
    }
    .menu-btn {
      display: inline-flex;
    }
    main,
    header {
      padding-left: 16px;
      padding-right: 16px;
    }
    main {
      padding-top: 12px;
    }
  }
</style>
