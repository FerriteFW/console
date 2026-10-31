# Channel library data

The data behind **Channels & Zones › Add channels**. Copied from NeonPlug (Alex's app), with small fixes.
The files live in `public/data/`. Console loads each one only when its tab opens.

Licensed sites (Canada's TAFL, the US FCC's ULS) and airports (OurAirports) are not here any more.
They live in the FerriteFW/data repo, published tiled by grid square at https://data.ferritefw.dev (airports by 2-character field).
Console reads them through `src/lib/sitedata.ts`; that repo's README has the format and the rebuild.
To try a local build: serve its `out/` (`python3 -m http.server 8090 -d ../data/out`), then `VITE_DATA_URL=http://localhost:8090 npm run dev`.
The tests never use the network: `tests/e2e/fixtures/sitedata/` holds a few tiny tiles, served by Playwright.

| File | Source | Size | Refresh |
| --- | --- | --- | --- |
| `fixed-channels.json` | Hand-made in NeonPlug, from `fixed-channels-source.md`; Airband from the sources below | 32 KB | Edit by hand |

## Formats

- Fixed sets: NeonPlug's format. `rxOnly: true` on a set or a frequency makes RX-only channels (Console added it for Weather).
  Optional per frequency: `ctcss` (Hz), `dcs` (code), `notes`.
  `defaultMode: "AM"` makes AM channels (Airband); otherwise the bandwidth picks NFM or FM.
- Airports: OurAirports' frequency types (the tiles' `tn`: TWR, GND, CLD, UNIC, CNTR, ...) map onto Console's type names and short forms in `core/src/library.rs` (`AIRPORT_TYPES`, `AIRPORT_ALIASES`). Others show as they are.

## Airband (common)

Airband frequencies not tied to one airport, all AM and RX only. Each one's `notes` say where it applies and cite its source.

- FAA Aeronautical Information Manual (AIM): 4-1-11 and table 4-1-11 (UNICOM/MULTICOM, air-to-air, helicopter air-to-air, flight training, flight test), 4-2-14 (122.2 FSS), 6-3-1 (121.5 emergency). https://www.faa.gov/air_traffic/publications/atpubs/aim_html/
- FAA AIP GEN 3.6 (search and rescue: SAR aircraft and boats on 121.5 and 123.1). https://www.faa.gov/air_traffic/publications/atpubs/aip_html/part1_gen_section_3.6.html
- Transport Canada AIM (TC AIM), March 20, 2025 edition: COM 1.4.2 (121.5), RAC 1.2.1 (UNICOM frequencies, among them 123.3 and 123.5), RAC 4.5.1 and 4.5.5 (123.2 where no MF or ATF is published), RAC 5.1 (126.7 en route), RAC 11.7.14 (123.45 inter-pilot air-to-air), SAR 4.2 (126.7, 121.5). https://tc.canada.ca/en/aviation/publications/transport-canada-aeronautical-information-manual-tc-aim
- Not included: frequencies only forums or scanner lists give (UNICOM frequencies belong to their airport: the Airports tab has them).

## Changes from NeonPlug

- TAFL moved to FerriteFW/data (Oct 30, 2026). Frequencies there keep their half kHz too.
- Airports moved to FerriteFW/data (Oct 30, 2026), from OurAirports (public domain) instead of komed3/airportmap-database; `airportdata.py` is gone.
- Airband (common) added (Oct 30, 2026); the Airports tab's "common frequencies" checkbox adds it instead of NeonPlug's RadioReference list.
- Weather is marked RX only.
