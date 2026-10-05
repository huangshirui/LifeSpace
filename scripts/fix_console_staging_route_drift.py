from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
path = ROOT / "apps/console/scripts/verify-staging-control-plane.mjs"
text = path.read_text()

old_route_const = 'const modelRoute = `console-acceptance-${runSuffix}`.slice(0, 63);\n'
old_route_property = '    route: modelRoute,\n'

if text.count(old_route_const) != 1:
    raise SystemExit(f"expected one modelRoute constant, got {text.count(old_route_const)}")
if text.count(old_route_property) != 1:
    raise SystemExit(f"expected one route property, got {text.count(old_route_property)}")

text = text.replace(old_route_const, "", 1)
text = text.replace(old_route_property, "", 1)
path.write_text(text)

print("Removed retired Model Definition route field from Console staging acceptance fixture")
