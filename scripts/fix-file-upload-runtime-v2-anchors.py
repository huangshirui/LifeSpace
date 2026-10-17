from pathlib import Path

path = Path("scripts/apply-file-upload-runtime-v2.py")
text = path.read_text()
old = 'relationErrors.forEach((error, index) => { if (error) recordItems[index]!.error = error; });'
new = 'recordItems.forEach((item, index) => { if (relationErrors[index]) item.error = relationErrors[index]!; });'
if old not in text:
    raise SystemExit("native-model-batch relation anchor not found in v2 patch")
path.write_text(text.replace(old, new))
