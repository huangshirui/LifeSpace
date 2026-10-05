from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
path = ROOT / "apps/console/scripts/verify-staging-control-plane.mjs"
text = path.read_text()
old = '    acceptanceModel: { key: modelKey, route: modelRoute, publishedVersions: [1, 2], retired: true },\n'
new = '    acceptanceModel: { key: modelKey, publishedVersions: [1, 2], retired: true },\n'
if text.count(old) != 1:
    raise SystemExit(f"expected one stale acceptanceModel route summary, got {text.count(old)}")
path.write_text(text.replace(old, new, 1))
print("Removed retired route field from Console staging acceptance summary")
