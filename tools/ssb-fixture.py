#!/usr/bin/env python3
"""Makes core/tests/fixtures/ssb-synthetic.json with ferrite's own ssbpatch.py: python3 tools/ssb-fixture.py core/tests/fixtures/ssb-synthetic.bin"""
import hashlib, json, struct, sys
sys.path.insert(0, __import__('os').path.join(__import__('os').path.dirname(__file__), '..', '..', 'ferrite', 'tools'))
import ssbpatch
patch = ssbpatch.extract(sys.argv[1])  # a .bin: unpacked image
img = bytearray(((i * 7 + 3) & 0xFF) for i in range(30000))
img[0:4] = struct.pack('<I', 0x20018000); img[4:8] = struct.pack('<I', 0x08003201)
img[0x3E0:0x3EC] = b"RT-950      "; img[0x7E0:0x7EC] = b"RT-950      "
img[0x900:0x910] = b"Ferrite terminal"
b, at = ssbpatch.bundle(bytes(img), patch)
print(json.dumps({"made_by": "ferrite/tools/ssbpatch.py extract + bundle (see README.md)",
  "patch_len": len(patch), "patch_sha256": hashlib.sha256(patch).hexdigest(),
  "bundle_at": at, "bundle_sha256": hashlib.sha256(b).hexdigest()}, indent=1))
