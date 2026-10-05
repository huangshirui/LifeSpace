from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
path = ROOT / "apps/core/openapi.yaml"
text = path.read_text()
old = '"contractVersion":{"const":"0.43.0"}'
new = '"contractVersion":{"const":"0.44.0"}'
if text.count(old) != 1:
    raise SystemExit(f"expected one Core StatusResponse contractVersion match, got {text.count(old)}")
path.write_text(text.replace(old, new, 1))
print("Aligned Core StatusResponse contractVersion to 0.44.0")
