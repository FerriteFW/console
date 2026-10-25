<script lang="ts">
  // The shell: sidebar (sections grouped as UV Studio groups its own: Viewer, Tools, Console), the connection bar,
  // and the page. Pages by hash (#/live, #/about, ...) so a reload stays put.
  import ConnectionBar from "./lib/components/ConnectionBar.svelte";
  import Wordmark from "./lib/components/Wordmark.svelte";
  import LiveView from "./lib/pages/LiveView.svelte";
  import About from "./lib/pages/About.svelte";
  import Channels from "./lib/pages/Channels.svelte";
  import Terminal from "./lib/pages/Terminal.svelte";
  import Settings from "./lib/pages/Settings.svelte";
  import Firmware from "./lib/pages/Firmware.svelte";
  import Install from "./lib/pages/Install.svelte";
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
  import Soon from "./lib/pages/Soon.svelte";
  import { loadCore } from "./lib/core";
  import { radio } from "./lib/radio.svelte";
  import { aprs } from "./lib/aprs.svelte";
  import { aprsSettings } from "./lib/aprsSettings.svelte";
  import { contacts } from "./lib/contacts.svelte";
  import { activity } from "./lib/activity.svelte";
  import { route } from "./lib/route.svelte";

  // `sub`: a group within the group (Tools › APRS), its pages indented under its name.
  type Page = { id: string; name: string; soon?: string; sub?: string };
  const groups: { name: string; pages: Page[] }[] = [
    {
      name: "Viewer",
      pages: [
        { id: "live", name: "Live View" },
        { id: "activity", name: "Event Log" },
      ],
    },
    {
      name: "Tools",
      pages: [
        { id: "channels", name: "Channels & Zones" },
        { id: "settings", name: "Radio Settings" },
        { id: "terminal", name: "Terminal" },
        { id: "install", name: "Install" },
        { id: "firmware", name: "Firmware Update" },
        { id: "aprs-messages", name: "Messages", sub: "APRS" },
        { id: "aprs-heard", name: "Heard stations", sub: "APRS" },
        { id: "aprs-contacts", name: "Contacts", sub: "APRS" },
        { id: "aprs-map", name: "Map", sub: "APRS" },
        { id: "aprs-settings", name: "APRS Settings", sub: "APRS" },
      ],
    },
    { name: "Console", pages: [{ id: "about", name: "About" }] },
  ];
  const all = groups.flatMap((g) => g.pages);

  let navOpen = $state(false);
  let coreError = $state("");
  const page = $derived(all.find((p) => p.id === route.id)?.id ?? "live");
  // `#install` (no slash): the Install page alone, for setting up a new radio (ferritefw.dev/install).
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
  if (params.has("demo")) {
    void radio.connect("demo").then(async () => {
      for (const k of (params.get("press") ?? "").split(",").filter(Boolean)) {
        await new Promise((r) => setTimeout(r, 300));
        const [name, how] = k.split(":");
        await radio.press(name, how === "long");
      }
    });
  }

  const current = $derived(all.find((p) => p.id === page)!);
</script>

{#if focus}
  <div class="focus-shell">
    <div class="brand focus-brand"><Wordmark /></div>
    {#if coreError}<div class="banner">{coreError}</div>{/if}
    <main><Install focus /></main>
  </div>
{:else}
<div class="shell" class:nav-open={navOpen}>
  <aside class="side">
    <div class="brand"><Wordmark /></div>
    <nav aria-label="Sections">
      {#each groups as g (g.name)}
        <div class="group">
          <div class="label">{g.name}</div>
          {#each g.pages as p, k (p.id)}
            {#if p.sub && p.sub !== g.pages[k - 1]?.sub}<div class="sublabel">{p.sub}</div>{/if}
            <a
              class:in-sub={!!p.sub}
              href={`#/${p.id}`}
              class:active={p.id === page}
              aria-current={p.id === page ? "page" : undefined}
              onclick={() => (navOpen = false)}
            >
              <span>{p.name}</span>
              {#if p.soon}<span class="tag">Soon</span>{/if}
            </a>
          {/each}
        </div>
      {/each}
    </nav>
    <div class="side-foot">For Ferrite on the Radtel RT-950 Pro</div>
  </aside>

  <div class="main">
    <header>
      <button class="btn quiet menu-btn" aria-label="Sections" onclick={() => (navOpen = !navOpen)}>☰</button>
      <ConnectionBar />
    </header>
    {#if coreError}<div class="banner">{coreError}</div>{/if}
    <main>
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
      {:else}
        <Soon title={current.name} text={current.soon ?? ""} />
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
    gap: 18px;
  }
  .group {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .group .label {
    padding: 0 8px 6px;
    font-size: 11px;
  }
  nav a {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 7px 8px;
    border-radius: 7px;
    color: var(--text);
    text-decoration: none;
  }
  .sublabel {
    padding: 10px 8px 4px;
    font-size: 11px;
    color: var(--sub);
  }
  nav a.in-sub {
    padding-left: 20px;
  }
  nav a:hover {
    background: var(--raised);
  }
  nav a.active {
    background: var(--blue);
    color: var(--blue-fg);
    font-weight: 700;
  }
  .tag {
    font-size: 10px;
    color: var(--sub);
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 0 5px;
  }
  .side-foot {
    margin-top: auto;
    color: var(--dim);
    font-size: 11px;
    padding: 0 8px;
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
