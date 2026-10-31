# Channel library data

The data behind **Channels & Zones › Add channels**. Copied from NeonPlug (Alex's app), with small fixes.
The files live in `public/data/`. Console loads each one only when its tab opens.

Licensed sites (Canada's TAFL, the US FCC's ULS) are not here any more.
They live in the FerriteFW/data repo, published tiled by grid square at https://data.ferritefw.dev.
Console reads them through `src/lib/sitedata.ts`; that repo's README has the format and the rebuild.
To try a local build: serve its `out/` (`python3 -m http.server 8090 -d ../data/out`), then `VITE_DATA_URL=http://localhost:8090 npm run dev`.
The tests never use the network: `tests/e2e/fixtures/sitedata/` holds a few tiny tiles, served by Playwright.

| File | Source | Size | Refresh |
| --- | --- | --- | --- |
| `fixed-channels.json` | Hand-made in NeonPlug, from `fixed-channels-source.md` | 20 KB | Edit by hand |
| `airports.json` | komed3/airportmap-database on GitHub (MIT) | 750 KB | `airportdata.py` |

## Refresh

From the repo root:

```sh
python3 tools/library/airportdata.py public/data/airports.json
```

- `airportdata.py` downloads two CSVs and keeps 108-137 MHz frequencies with their types.

## Formats

- Fixed sets: NeonPlug's format. `rxOnly: true` on a set or a frequency makes RX-only channels (Console added it for Weather).
  Optional per frequency: `ctcss` (Hz), `dcs` (code), `notes`.
- Airports: `{"c": ICAO, "l": [lat, lon], "f": [[kHz, type code], ...]}`. Type codes are in `airportdata.py` and `core/src/library.rs`.

## Changes from NeonPlug

- TAFL moved to FerriteFW/data (Oct 30, 2026). Frequencies there keep their half kHz too.
- `airportdata.py` takes an output path.
- Weather is marked RX only.
