# Test fixtures

- `ssb-synthetic.bin`: a made-up stock-like image with a run of Si473x patch records in it (random bytes, nothing from Radtel's firmware). Written by the ignored test `install::tests::write_ssb_fixture`.
- `ssb-synthetic.json`: what `ferrite/tools/ssbpatch.py` makes of it: the patch it extracts and the bundle into a test Ferrite image (the same image as `install::tests::image(30_000, FERRITE_MARK)`). Made by `tools/ssb-fixture.py`.
- `signed-test.btf`, `.btf.minisig`, `.pub`: a small made-up file signed with a throwaway minisign key (`minisign -G -W`, then `minisign -S -t "Ferrite test0000"`), for `signature::tests`. Not Ferrite's key.
