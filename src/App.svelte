<script lang="ts">
  // The shell: sidebar (sections grouped as UV Studio groups its own: Viewer, Tools, Console), the connection bar,
  // and the page. Pages by hash (#/live, #/about, ...) so a reload stays put.
  import ConnectionBar from "./lib/components/ConnectionBar.svelte";
  import Wordmark from "./lib/components/Wordmark.svelte";
  import LiveView from "./lib/pages/LiveView.svelte";
  import About from "./lib/pages/About.svelte";
  import Channels from "./lib/pages/Channels.svelte";
  import Terminal from "./lib/pages/Terminal.svelte";
  import { channels } from "./lib/channels.svelte";
  import { library } from "./lib/library.svelte";
  import Soon from "./lib/pages/Soon.svelte";
  import { loadCore } from "./lib/core";
  import { radio } from "./lib/radio.svelte";

  type Page = { id: string; name: string; soon?: string };
  const groups: { name: string; pages: Page[] }[] = [
    {
      name: "Viewer",
      pages: [
        { id: "live", name: "Live View" },
        { id: "activity", name: "Activity Log", soon: "What the radio heard and sent, with times, from the radio's own log (LOG_READ)." },
      ],
    },
    {
      name: "Tools",
      pages: [
        { id: "channels", name: "Channels & Zones" },
        { id: "settings", name: "Radio Settings", soon: "The radio-wide settings record, read and written over the link." },
        { id: "terminal", name: "Terminal" },
        { id: "firmware", name: "Firmware Update", soon: "Restart into the bootloader (REBOOT) and flash a Ferrite image." },
      ],
    },
    { name: "Console", pages: [{ id: "about", name: "About" }] },
  ];
  const all = groups.flatMap((g) => g.pages);

  let page = $state(pageFromHash());
  let navOpen = $state(false);
  let coreError = $state("");

  function pageFromHash() {
    const id = location.hash.replace(/^#\/?/, "");
    return all.find((p) => p.id === id)?.id ?? "live";
  }

  $effect(() => {
    const on = () => (page = pageFromHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
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
  (window as unknown as { ferrite: unknown }).ferrite = { radio, channels, library };
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

<div class="shell" class:nav-open={navOpen}>
  <aside class="side">
    <div class="brand"><Wordmark /></div>
    <nav aria-label="Sections">
      {#each groups as g (g.name)}
        <div class="group">
          <div class="label">{g.name}</div>
          {#each g.pages as p (p.id)}
            <a
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
      {:else if page === "about"}
        <About />
      {:else}
        <Soon title={current.name} text={current.soon ?? ""} />
      {/if}
    </main>
  </div>
</div>

<style>
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
