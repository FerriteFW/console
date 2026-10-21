# Channel library data

The data behind **Channels & Zones › Add channels**. Copied from NeonPlug (Alex's app), with small fixes.
The files live in `public/data/`. Console loads each one only when its tab opens.

| File | Source | Size | Refresh |
| --- | --- | --- | --- |
| `fixed-channels.json` | Hand-made in NeonPlug, from `fixed-channels-source.md` | 20 KB | Edit by hand |
| `airports.json` | komed3/airportmap-database on GitHub (MIT) | 750 KB | `airportdata.py` |
| `tafl.json` | ISED Canada's TAFL (licensed stations), public download | 11 MB | `tafldata.py` |

## Refresh

From the repo root:

```sh
python3 tools/library/airportdata.py public/data/airports.json
python3 tools/library/tafldata.py --download --cache /tmp/tafl --out public/data/tafl.json
```

- `airportdata.py` downloads two CSVs and keeps 108-137 MHz frequencies with their types.
- `tafldata.py` downloads a 67 MB zip (a 470 MB CSV inside).
  It keeps 136-174 and 400-470 MHz and shortens licensee names to 16 characters.
  Without `--download` it reuses the zip and CSV in `--cache`.

## Formats

- Fixed sets: NeonPlug's format. `rxOnly: true` on a set or a frequency makes RX-only channels (Console added it for Weather).
  Optional per frequency: `ctcss` (Hz), `dcs` (code), `notes`.
- Airports: `{"c": ICAO, "l": [lat, lon], "f": [[kHz, type code], ...]}`. Type codes are in `airportdata.py` and `core/src/library.rs`.
- TAFL: `{"c": name, "l": [lat, lon], "f": kHz}`.

## Changes from NeonPlug

- TAFL frequencies keep their half kHz. NeonPlug's copy truncated them: 469.9875 MHz read as 469.987.
  About 60,000 of 192,000 entries were off by 500 Hz.
- TAFL names: a missing comma in the noise-word list ran "canada" and "de" together; fixed.
- Both scripts take an output path; `tafldata.py` takes a cache folder.
- Weather is marked RX only.
