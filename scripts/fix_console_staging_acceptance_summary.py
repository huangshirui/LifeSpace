from pathlib import Path

path = Path('apps/console/scripts/verify-staging-control-plane.mjs')
text = path.read_text()
old = '    acceptanceModel: { key: modelKey, route: modelRoute, publishedVersions: [1, 2], retired: true },\n'
new = '    acceptanceModel: { key: modelKey, publishedVersions: [1, 2], retired: true },\n'
if text.count(old) != 1:
    raise SystemExit(f'expected one stale acceptance summary reference, got {text.count(old)}')
path.write_text(text.replace(old, new, 1))
print('removed obsolete modelRoute reference from Console staging acceptance summary')
