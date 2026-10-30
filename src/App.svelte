<script lang="ts">
  // The shell: the sidebar (the jobs, then More), the connection bar,
  // and the page. Pages by hash (#/live, #/about, ...) so a reload stays put.
  import ConnectionBar from "./lib/components/ConnectionBar.svelte";
  import ConnectModal from "./lib/components/ConnectModal.svelte";
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
  import { settings } from "./lib/settings.svelte";
  import { channels } from "./lib/channels.svelte";
  import { library } from "./lib/library.svelte";
  import ActivityLog from "./lib/pages/ActivityLog.svelte";
  import AprsHeard from "./lib/pages/AprsHeard.svelte";
  import AprsMessages from "./lib/pages/AprsMessages.svelte";
  import AprsMap from "./lib/pages/AprsMap.svelte";
  import AprsSettings from "./lib/pages/AprsSettings.svelte";
  import AprsContacts from "./lib/pages/AprsContacts.svelte";
  import { loadCore } from "./lib/core";
  import { radio } from "./lib/radio.svelte";
  import { aprs } from "./lib/aprs.svelte";
  import { aprsSettings } from "./lib/aprsSettings.svelte";
  import { contacts } from "./lib/contacts.svelte";
  import { activity } from "./lib/activity.svelte";
  import { route } from "./lib/route.svelte";

  // The sidebar: the jobs first, then More. A section with `tabs` covers several pages, shown as tabs above them
  // (APRS, Firmware); its link opens the first.
  type Page = { id: string; name: string; soon?: string };
  type Section = { id: string; name: string; tabs?: Page[] };
  const sections: Section[] = [
    { id: "live", name: "Live View" },
    { id: "channels", name: "Channels & Zones" },
    { id: "settings", name: "Radio Settings" },
    {
      id: "aprs",
      name: "APRS",
      tabs: [
        { id: "aprs-messages", name: "Messages" },
        { id: "aprs-heard", name: "Heard stations" },
        { id: "aprs-map", name: "Map" },
        { id: "aprs-contacts", name: "Contacts" },
        { id: "aprs-settings", name: "Settings" },
      ],
    },
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
    { id: "about", name: "About" },
  ];
  const all: Page[] = [...sections.flatMap((x) => x.tabs ?? [{ id: x.id, name: x.name }]), ...more];
  const sectionOf = (id: string) => sections.find((x) => x.id === id || x.tabs?.some((t) => t.id === id));
  const hrefOf = (x: Section) => `#/${x.tabs ? x.tabs[0].id : x.id}`;

  let navOpen = $state(false);
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
  (window as unknown as { ferrite: unknown }).ferrite = { radio, channels, library, settings, firmware, install, aprs, aprsSettings, activity, contacts };
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
  $effect(() => {
    if (radio.phase === "connected" || radio.phase === "updating") welcome = false;
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
          {#if x.id === "channels" && channels.pending}<span class="badge" title="Changes not written to the radio yet">{channels.pending} unwritten</span>{/if}
        </a>
      {/each}
      <div class="label">More</div>
      {#each more as p (p.id)}
        <a href={`#/${p.id}`} class:active={p.id === page} aria-current={p.id === page ? "page" : undefined} onclick={() => (navOpen = false)}>
          <span>{p.name}</span>
        </a>
      {/each}
    </nav>
    <div class="side-foot">
      <a class="guide" href="https://manual.ferritefw.dev" target="_blank" rel="noopener">User guide ↗</a>
      For Ferrite on the Radtel RT-950 Pro
    </div>
  </aside>

  <div class="main">
    <header>
      <button class="btn quiet menu-btn" aria-label="Sections" onclick={() => (navOpen = !navOpen)}>☰</button>
      <ConnectionBar />
    </header>
    {#if coreError}<div class="banner">{coreError}</div>{/if}
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
      {/if}
    </main>
  </div>
</div>
{/if}

<style>
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
