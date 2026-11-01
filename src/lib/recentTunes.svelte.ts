// Live View's recent tunes: the last 10 frequencies tuned from Tune from map, remembered in this browser
// (localStorage; a private window just forgets them), each to tune again or add as a channel.
import { readRecent, remember, tuneItem, type Tune } from "./tune";
import { library } from "./library.svelte";
import type { LibraryItem } from "./core";

const KEY = "ferrite.recentTunes";

class RecentTunes {
  list = $state<Tune[]>(load());
  /** The last Add as channel's note ("Added: ... to the channel table"). */
  note = $state("");

  add(t: Tune) {
    this.list = remember(this.list, $state.snapshot(t) as Tune);
    save(this.list);
  }

  /** Tune again (the active slot, as Tune from map does); it moves to the top. True when tuned. */
  async tune(t: Tune): Promise<boolean> {
    const ok = await library.tune($state.snapshot(t) as Tune);
    if (ok) this.add(t);
    return ok;
  }

  forget(t: Tune) {
    this.list = this.list.filter((x) => x !== t);
    save(this.list);
  }

  /** Into the channel table as Add channels does it (new rows green until Write). */
  addChannel(t: Tune) {
    const a = library.add([tuneItem($state.snapshot(t) as Tune) as LibraryItem], t.name);
    this.note = a.channels.length
      ? `Added ${t.name} as channel ${a.channels[0].number}: write it from Channels`
      : `Not added: ${a.notes[0] ?? "the table is full"}`;
  }
}

function load(): Tune[] {
  try {
    return readRecent(localStorage.getItem(KEY));
  } catch {
    return [];
  }
}

function save(list: Tune[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* private window: not remembered */
  }
}

export const recentTunes = new RecentTunes();
