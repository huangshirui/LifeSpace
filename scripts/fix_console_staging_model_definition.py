from pathlib import Path

path = Path('apps/console/scripts/verify-staging-control-plane.mjs')
text = path.read_text()
old_const = 'const modelRoute = `console-acceptance-${runSuffix}`.slice(0, 63);\n'
old_field = '    route: modelRoute,\n'
if text.count(old_const) != 1:
    raise SystemExit(f'expected one modelRoute const, got {text.count(old_const)}')
if text.count(old_field) != 1:
    raise SystemExit(f'expected one route field, got {text.count(old_field)}')
text = text.replace(old_const, '', 1).replace(old_field, '', 1)
path.write_text(text)
print('removed obsolete route property from Console staging Model Definition fixture')
