"""Restore upstream-declared source bytes only when a line-ending conversion matches its hash."""
import hashlib
import json
from pathlib import Path
import sys

root = Path(sys.argv[1])
records = json.loads((root / "data/source-hashes.json").read_text(encoding="utf-8"))
for name in ("director-inquiries.json", "visual-style-materials.json"):
    library = json.loads((root / "data" / name).read_text(encoding="utf-8"))
    records.append({"file": library["source_file"], "sha256": library["source_sha256"]})
for record in records:
    file = (root / record["file"]).resolve()
    if not file.is_relative_to(root.resolve()):
        raise ValueError("Source escaped runtime")
    data = file.read_bytes()
    if hashlib.sha256(data).hexdigest() == record["sha256"]:
        continue
    lf = data.replace(b"\r\n", b"\n")
    for candidate in (lf, lf.replace(b"\n", b"\r\n")):
        if hashlib.sha256(candidate).hexdigest() == record["sha256"]:
            file.write_bytes(candidate)
            break
    else:
        raise ValueError("Upstream source hash mismatch: " + record["file"])
