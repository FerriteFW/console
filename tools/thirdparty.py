#!/usr/bin/env python3
"""public/THIRD-PARTY-LICENSES.md: the notices for what other people wrote that ships in Ferrite Console. About shows it.

    python3 tools/thirdparty.py           # writes public/THIRD-PARTY-LICENSES.md
    python3 tools/thirdparty.py --check   # exit 1 if the file is stale (before a release)

What counts: the Rust crates linked into the desktop app (src-tauri, for macOS, Linux and Windows) and into the web
build's WebAssembly (wasm, wasm32), from cargo metadata: normal dependencies only, less proc-macro crates and what only
they pull in (build time, nothing in the app), less our own crates; the npm packages the page ships (package.json's
dependencies, not devDependencies); the fonts it draws with (../ferrite/fonts); the libraries the Linux AppImage
carries; and the map's data. The radio's own firmware, bundled for Install and Update, has its notices in ferrite's
THIRD-PARTY-LICENSES.md.
Crates offered under several licences are taken under MIT where it is one of them. Each crate's own licence file is
quoted (its copyright line matters); a crate that ships none gets the standard MIT text with its authors.
Standard library only.
"""
import json, os, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "THIRD-PARTY-LICENSES.md")
BUILDS = [  # (manifest, root package, targets)
    ("src-tauri/Cargo.toml", "ferrite-console-app", ["aarch64-apple-darwin", "x86_64-unknown-linux-gnu", "x86_64-pc-windows-msvc"]),
    ("wasm/Cargo.toml", "ferrite-console-wasm", ["wasm32-unknown-unknown"]),
]
FONTS = [  # (name, use, licence file): the web fonts scripts/fonts.mjs cuts from ferrite's TTFs
    ("JetBrains Mono", "the interface text", "../ferrite/fonts/OFL-JetBrainsMono.txt"),
    ("Barlow Semi Condensed", "the FERRITE wordmark", "../ferrite/fonts/OFL-BarlowSemiCondensed.txt"),
]
MIT_TEXT = """Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE."""
BSD3_TEXT = """Redistribution and use in source and binary forms, with or without modification, are permitted provided that the
following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following
   disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following
   disclaimer in the documentation and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote
   products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES,
INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE."""
LINUX_LIBS = """The Linux AppImage carries the system libraries the desktop app runs on, as built by the AppImage tooling:
among them WebKitGTK, GTK 3, GLib, libsoup, Cairo, Pango and HarfBuzz. They are unmodified and keep their own
licences, most of them the GNU Lesser General Public License (LGPL 2 or 2.1, or later); their source is at their
projects (webkitgtk.org, gtk.org, gnome.org) and in every major Linux distribution's source packages. You may replace
them: the AppImage can be extracted (--appimage-extract) and run with your own builds of these libraries.
The macOS and Windows apps use the system's own web view (WebKit, WebView2) and carry no such libraries."""
MAP = """The map's tiles come from OpenStreetMap, © OpenStreetMap contributors, under the Open Database License
(openstreetmap.org/copyright), fetched while you use the map; they are not part of the app. The channel library's
data (data.ferritefw.dev) names its own sources and licences where it shows them."""


def crates():
    seen_ids, pk, found = set(), {}, {}
    for manifest, root_name, targets in BUILDS:
        for t in targets:
            m = json.loads(subprocess.run(
                ["cargo", "metadata", "--format-version", "1", "--filter-platform", t,
                 "--manifest-path", os.path.join(ROOT, manifest)],
                check=True, capture_output=True, text=True).stdout)
            pk = {p["id"]: p for p in m["packages"]}
            nodes = {n["id"]: n for n in m["resolve"]["nodes"]}
            root = next(p["id"] for p in m["packages"] if p["name"] == root_name and p["source"] is None)
            seen, stack = set(), [root]
            while stack:
                i = stack.pop()
                if i in seen:
                    continue
                if any("proc-macro" in k["kind"] for k in pk[i]["targets"]):
                    continue  # build time only: nothing of it is linked
                seen.add(i)
                for d in nodes[i]["deps"]:
                    if any(k["kind"] is None for k in d["dep_kinds"]):
                        stack.append(d["pkg"])
            for i in seen:
                p = pk[i]
                if p["source"] is not None:
                    found[(p["name"], p["version"])] = p
            seen_ids |= seen
    return [found[k] for k in sorted(found)]


def chosen(expr):
    """The licence we take a crate under: MIT where offered, else the expression as given."""
    expr = expr or "unknown"
    words = expr.replace("/", " OR ").replace("(", " ").replace(")", " ").split()
    if "MIT" in words and " AND " not in expr:
        return "MIT"
    return expr


def licence_text(d, name, authors, lic):
    names = sorted(os.listdir(d))
    pick = [n for n in names if n.upper().startswith(("LICENSE-MIT", "LICENCE-MIT"))] if lic == "MIT" else []
    pick = pick or [n for n in names if n.upper().startswith(("LICENSE", "LICENCE", "COPYING", "UNLICENSE"))
                    and "APACHE" not in n.upper() and os.path.isfile(os.path.join(d, n))]
    if pick:
        return "\n\n".join(open(os.path.join(d, n), encoding="utf-8", errors="replace").read().strip() for n in pick)
    if lic == "MIT":
        return "MIT License\n\nCopyright (c) " + ", ".join(authors or ["the " + name + " authors"]) + "\n\n" + MIT_TEXT
    who = ", ".join(authors or ["the " + name + " authors"])
    if lic == "BSD-3-Clause":
        return f"BSD 3-Clause License\n\nCopyright (c) {who}\n\n" + BSD3_TEXT
    if lic == "MPL-2.0":
        return (f"Mozilla Public License 2.0, by {who}. The full licence: https://mozilla.org/MPL/2.0/. This package is "
                f"used unmodified; its source: https://crates.io/crates/{name}.")
    sys.exit(f"{name}: no licence file and no standard text for {lic}: add it by hand")


def npm():
    pkg = json.load(open(os.path.join(ROOT, "package.json")))
    out = []
    for name in sorted(pkg.get("dependencies", {})):
        d = os.path.join(ROOT, "node_modules", name)
        meta = json.load(open(os.path.join(d, "package.json")))
        auth = meta.get("author")
        auth = [auth if isinstance(auth, str) else auth.get("name", "")] if auth else []
        out.append((name, meta["version"], meta.get("license", "unknown"), d, auth))
    return out


def render():
    cs, ns = crates(), npm()
    out = ["# Third-party licences", "",
           "Ferrite Console includes the work of others, listed here with their licences. Console itself is under the",
           "PolyForm Noncommercial licence (LICENSE.md). The radio firmware it installs lists its own in Ferrite's",
           "THIRD-PARTY-LICENSES.md. Generated by `tools/thirdparty.py`; don't edit.", "",
           "## Rust crates", "", "Every crate is used unmodified; each one's source is on crates.io under its name and version",
           "(the MPL-2.0 ones included).", "", "| Crate | Version | Licence | Taken under |", "|---|---|---|---|"]
    for p in cs:
        out.append(f"| {p['name']} | {p['version']} | {p['license']} | {chosen(p['license'])} |")
    out.append("| Rust standard library | the toolchain's | MIT OR Apache-2.0 | MIT |")
    out += ["", "## npm packages", "", "| Package | Version | Licence | Taken under |", "|---|---|---|---|"]
    for name, ver, lic, _, _ in ns:
        out.append(f"| {name} | {ver} | {lic} | {chosen(lic)} |")
    out += ["", "## Fonts", ""]
    for name, use, _ in FONTS:
        out.append(f"- {name} (SIL Open Font License 1.1): {use}.")
    out += ["", "## Linux libraries", "", LINUX_LIBS, "", "## Map data", "", MAP, "", "## Licence texts", ""]
    for p in cs:
        lic = chosen(p["license"])
        out += [f"### {p['name']} {p['version']}", "", "```",
                licence_text(os.path.dirname(p["manifest_path"]), p["name"], p["authors"], lic), "```", ""]
    out += ["### Rust standard library", "", "```", "MIT License\n\nCopyright (c) The Rust Project Developers\n\n" + MIT_TEXT, "```", ""]
    for name, ver, lic, d, auth in ns:
        out += [f"### {name} {ver}", "", "```", licence_text(d, name, auth, chosen(lic)), "```", ""]
    for name, _, f in FONTS:
        out += [f"### {name}", "", "```", open(os.path.join(ROOT, f), encoding="utf-8").read().strip(), "```", ""]
    return "\n".join(out)


if __name__ == "__main__":
    text = render()
    if "--check" in sys.argv:
        old = open(OUT, encoding="utf-8").read() if os.path.exists(OUT) else ""
        if old != text:
            sys.exit("public/THIRD-PARTY-LICENSES.md is stale: run python3 tools/thirdparty.py")
        print("public/THIRD-PARTY-LICENSES.md: current")
    else:
        open(OUT, "w", encoding="utf-8").write(text)
        n = text.count("\n### ")
        print(f"wrote {OUT}: {n} licence texts, {len(text) // 1024} KB")
