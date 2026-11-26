#!/usr/bin/env python3
"""The radio journey's second opinion: the radio itself, over its Bluetooth, while Console holds the cable.

One session for the whole run (a Bluetooth connect takes seconds), driven by JSON lines on stdin, one answer a line
on stdout: {"ok": RESULT} or {"error": TEXT}. Requests:

    {"do": "hello"}                       -> {"firmware": "v0.9.7", "build": "tx+dry", "bench": true}
    {"do": "used", "what": "channel"}     -> [numbers as the radio shows them]
    {"do": "channel", "n": 3999}          -> {"name": ..., "rx": Hz/10, "zone": N|null, "hex": record}  (null: empty)
    {"do": "record", "what": "zone", "n": 3} -> the record's hex, or null when the radio holds none
    {"do": "settings"}                    -> the settings record's hex (PIN and tokens read as zeros)
    {"do": "ui"}                          -> the screen's text (LINK-19's readback)
    {"do": "get", "id": "0 7 5 1"}        -> the radio's own `get` line for that menu number
    {"do": "keys", "keys": "EXIT MENU"}   -> null

Uses ferrite/tools/ferrite_link.py (FERRITE_DIR, else ../ferrite beside this checkout). Reads only, plus keys: it
never writes the radio and never keys it.
"""
import json
import os
import sys

here = os.path.dirname(os.path.abspath(__file__))
ferrite = os.environ.get("FERRITE_DIR") or os.path.join(here, "..", "..", "..", "ferrite")
sys.path.insert(0, os.path.join(ferrite, "tools"))
import ferrite_link as fl  # noqa: E402

# A busy radio (a decoder running) answers the UI readback over Bluetooth in more than the tool's 6 s.
_ask = fl.Link.ask


def _patient(self, ty, payload=b"", timeout=None, retry_pending=30):
    if timeout is None and getattr(self.p, "slow", False):
        timeout = 20.0
    return _ask(self, ty, payload, timeout, retry_pending)


fl.Link.ask = _patient


def main():
    port = fl.Port(sys.argv[1])
    link = fl.Link(port)
    hello = link.hello()
    fl.ble_fast(link)
    if not hello[2]:
        print(json.dumps({"error": "the radio's PIN lock is on"}), flush=True)
        return
    radio = fl.Radio.__new__(fl.Radio)
    radio.port, radio.link = link.p, link
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        if not line.strip():
            continue
        q = json.loads(line)
        try:
            print(json.dumps({"ok": answer(q, link, radio)}), flush=True)
        except Exception as e:  # noqa: BLE001 (the test shows it)
            print(json.dumps({"error": f"{type(e).__name__}: {e}"}), flush=True)
    port.close()


def answer(q, link, radio):
    do = q["do"]
    if do == "hello":
        h = link.hello()
        ver, rest = fl.text(h[3:])
        return {"firmware": ver, "build": fl.build_name(rest), "bench": bool(fl.build_bench(rest))}
    if do == "used":
        what = fl.WHATS[q.get("what", "channel")]
        base = 1 if what == fl.CHANNEL else 0
        return [i + base for i in link.used(what)]
    if do == "channel":
        n = int(q["n"])
        if n - 1 not in link.used(fl.CHANNEL):
            return None
        rec = link.read(fl.CHANNEL, n - 1)
        num, zone, rx, name = fl.channel_fields(rec)
        return {"n": num + 1, "name": name, "rx": rx, "zone": None if zone == 0xFFFF else zone, "hex": rec.hex()}
    if do == "record":
        what = fl.WHATS[q["what"]]
        n = int(q["n"])
        if n not in link.used(what):
            return None
        return link.read(what, n).hex()
    if do == "settings":
        return link.read(fl.SETTINGS, 0).hex()
    if do == "ui":
        return radio.ui_text(0)
    if do == "get":
        line = "get " + q["id"]
        if not line.replace(" ", "").replace("get", "").isdigit():
            raise ValueError("get takes a menu number only")  # reads only: never a set line
        return radio.cmd(line).strip()
    if do == "keys":
        radio.keys(q["keys"])
        return None
    raise ValueError(f"unknown request {do!r}")


if __name__ == "__main__":
    main()
