import json
import zipfile
import io
import urllib.request
import csv
import os
import argparse

# -------------------------------
# Config
# -------------------------------
URL = "https://www.ic.gc.ca/engineering/SMS_TAFL_Files/TAFL_LTAF.zip"

# DM-32 frequency ranges in MHz
DM32_RANGES = [
    (136.0, 174.0),   # VHF
    (400.0, 470.0),   # UHF
]

def in_range(freq_mhz: float) -> bool:
    return any(lo <= freq_mhz <= hi for lo, hi in DM32_RANGES)


# -------------------------------
# Argument parsing
# -------------------------------
parser = argparse.ArgumentParser()
parser.add_argument("--download", action="store_true", help="Force download the ZIP")
parser.add_argument("--cache", default=".", help="Folder for TAFL_LTAF.zip and .csv (the download is ~67 MB, the CSV ~470 MB)")
parser.add_argument("--out", default="tafl_min.json", help="Output file (Console: public/data/tafl.json)")
args = parser.parse_args()
ZIP_CACHE = os.path.join(args.cache, "TAFL_LTAF.zip")
CSV_CACHE = os.path.join(args.cache, "TAFL_LTAF.csv")


# -------------------------------
# Download / cache ZIP
# -------------------------------
if args.download or not os.path.exists(ZIP_CACHE):
    print("Downloading TAFL dataset…")
    with urllib.request.urlopen(URL) as response:
        zip_bytes = response.read()
    with open(ZIP_CACHE, "wb") as f:
        f.write(zip_bytes)
else:
    print(f"Using cached ZIP: {ZIP_CACHE}")
    with open(ZIP_CACHE, "rb") as f:
        zip_bytes = f.read()


# -------------------------------
# Extract CSV
# -------------------------------
if args.download or not os.path.exists(CSV_CACHE):
    z = zipfile.ZipFile(io.BytesIO(zip_bytes))
    # Find CSV
    csv_name = [f for f in z.namelist() if f.lower().endswith(".csv")][0]
    print("Extracting CSV:", csv_name)
    csv_data = z.read(csv_name).decode("utf-8", errors="ignore")
    with open(CSV_CACHE, "w", encoding="utf-8") as f:
        f.write(csv_data)
else:
    print(f"Using cached CSV: {CSV_CACHE}")
    with open(CSV_CACHE, "r", encoding="utf-8") as f:
        csv_data = f.read()


import re

# -------------------------------
# Common word abbreviations
# -------------------------------
ABBREVIATIONS = {
    # Technical / station type
    "Broadcast": "BC",
    "Transmitter": "TX",
    "Station": "Stn",
    "Tower": "Tw",
    "Radio": "Rd",
    "FM": "FM",
    "AM": "AM",
    "Repeater": "Rpt",
    "Relay": "Rly",
    "Antenna": "Ant",
    "Base": "B",
    "Site": "St",
    "Mobile": "Mob",
    "Fixed": "FX",
    "VHF": "VHF",
    "UHF": "UHF",
    "Land Mobile": "",
    "Golf Course": "Golf",
    "Helicopter": "Heli",
    "Chemical": "Chem",

    # Geography / cities
    "Toronto": "Tor",
    "Vancouver": "Van",
    "Montreal": "Mtl",
    "Regina": "Rgn",
    "Calgary": "Cgy",
    "Edmonton": "Edm",
    "Ottawa": "Ott",
    "Winnipeg": "Wpg",
    "Quebec": "QC",
    "Saskatchewan": "SK",
    "British Columbia": "BC",
    "Nova Scotia": "NS",
    "Canada": "CAN",
}

# -------------------------------
# Words to completely remove
# -------------------------------
SHORT_NAME_REMOVE_WORDS = {
    # Core technical / radio / infrastructure
    "base","bases",
    "station","stations",
    "site","sites",
    "tower","towers",
    "antenna","antennas",
    "repeater","repeaters",
    "radio","radios",
    "vhf","uhf","fm","am","tx",
    "mobile","mobiles",
    "portable","portables","portatifs",
    "fleet","subscribers",

    # Government / public sector filler
    "service","services",
    "department","departments","dept","depts",
    "division","divisions",
    "branch","branches",
    "district","districts",
    "municipal","municipality",
    "public","publics",
    "authority","authorities",
    "agency","agencies",
    "commission","commissions",

    # Emergency / public safety — generic filler
    "operations","operation","ops",

    # Industrial / commercial filler
    "plant","plants",
    "facility","facilities",
    "construction","construct","contracting","contractors",
    "transport","transportation","logistics",
    "energy","power","hydro","gas",
    "utilities","utility",
    "properties",

    # Geographic filler
    "north","south","east","west",
    "central","centre","center","centres","centers",
    "zone","region","regional",
    "river","lake","lakes",
    "mountain","mountains","hill","hills",
    "road","rd","street","st","avenue","ave","boulevard","blvd",
    "hwy","highway","canada",

    # Common French equivalents
    "de","du","des","la","le","les","et",
    "travaux","incendies","répartition","publics",
    "of", "co",

    # Corporate suffixes
    "inc","inc.","ltd","ltd.","llc","corp","corporation","company","co","co.",
    "limited","services","solutions","group",

    # Noise words
    "system","systems",
    "control","controls",
    "office","offices",
    "project","projects",
    "unit","units",
    "team","teams",
    "area","areas",

}

# -------------------------------
# Canonical multi-word entities
# -------------------------------
CANONICAL_TERMS = {
    "fire department": "FD",
    "fire dept": "FD",
    "fire": "FD",
    "ems": "EMS",
    "ambulance": "EMS",
    "police": "PD",
    "rcmp": "RCMP",
}

# -------------------------------
# Smart name generator
# -------------------------------
def smart_name(name, max_len=16):
    """
    Generate a compact short name for TAFL entries:
    - Applies canonical replacements (fire/EMS/police)
    - Applies abbreviations
    - Removes noise words
    - Cleans punctuation
    - Truncates to max_len
    """
    # Normalize lowercase
    original = name
    name = name.lower()

    # Apply canonical multi-word replacements first
    for long, short in CANONICAL_TERMS.items():
        pattern = rf"\b{re.escape(long)}\b"
        name = re.sub(pattern, short, name, flags=re.IGNORECASE)

    # Apply ABBREVIATIONS (case-insensitive)
    for long, short in ABBREVIATIONS.items():
        pattern = rf"\b{re.escape(long)}\b"
        name = re.sub(pattern, short, name, flags=re.IGNORECASE)

    # Remove punctuation except underscores or hyphens
    name = re.sub(r"[.,&/()]", "", name)

    # Collapse multiple spaces to underscores
    words = name.split()

    # Remove remaining noise words
    words = [w for w in words if w not in SHORT_NAME_REMOVE_WORDS]

    # Join with underscores
    name = " ".join(words)

    # Remove any remaining non-alphanumeric except underscore
    name = re.sub(r"[^A-Za-z0-9_ ]", "", name)

    # Truncate to max_len
    if len(name) > max_len:
        name = name[:max_len]

    return name


# -------------------------------
# Is a generic company
# -------------------------------
results = []
def is_generic_number_name(name, num_digits=4):
    """
    Returns True if the name starts with num_digits or more digits.
    """
    return bool(re.match(rf"^\d{{{num_digits},}}", name))


# -------------------------------
# Parse CSV (positional)
# -------------------------------
results = []
seen = set()
reader = csv.reader(io.StringIO(csv_data))

for row in reader:
    try:
        if row[0] == "RX":
            continue
        freq_mhz = float(row[1])       # Column 2 (corrected)
        if not in_range(freq_mhz):
            continue

        if is_generic_number_name(row[54].strip()):
            continue

        callsign = smart_name(row[54].strip())     # Column 33
        lat = float(row[40])           # Column 41
        lon = float(row[41])           # Column 42
        # kHz, keeping 6.25 kHz channels' half kHz (469.9875 MHz is 469987.5, not 469987).
        freq_khz = round(freq_mhz * 1000, 2)
        if freq_khz == int(freq_khz):
            freq_khz = int(freq_khz)

        # Uniqueness key includes everything
        key = (callsign, freq_khz, lat, lon)
        if key in seen:
            continue  # skip duplicates
        seen.add(key)


        results.append({
            "c": callsign,
            "l": [round(lat, 4), round(lon, 4)],
            "f": freq_khz
        })

    except Exception:
        continue


# -------------------------------
# Output JSON
# -------------------------------
with open(args.out, "w", encoding="utf-8") as f:
    json.dump(results, f, separators=(',', ':'), ensure_ascii=False)
print(f"Wrote {len(results)} entries to {args.out}")

