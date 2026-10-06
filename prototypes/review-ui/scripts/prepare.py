"""Read-only source extraction and small embedded assets for the UI mockups."""
from pathlib import Path
from io import BytesIO
import base64
import hashlib
import json
import urllib.request
from PIL import Image

project = Path(__file__).resolve().parents[1]
source = project.parents[1] / "working-project/ieee-1547/raw/ieee1547-document.json"
document = json.loads(source.read_text(encoding="utf-8"))
pages = {}
for number in (18, 19, 33):
    page = document["pages"][str(number)]
    image_path = source.parent / page["image"]["uri"]
    with Image.open(image_path) as image:
        preview = image.convert("RGB")
        preview.thumbnail((700, 906))
        buffer = BytesIO()
        preview.save(buffer, format="JPEG", quality=78, optimize=True)
    elements = [item for item in document["texts"]
                if any(prov["page_no"] == number for prov in item.get("prov", []))]
    pages[str(number)] = {
        "number": number,
        "width": page["size"]["width"],
        "height": page["size"]["height"],
        "image": "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode(),
        "elements": elements,
    }
fixtures = {"document": document["name"], "fingerprint": hashlib.sha256(source.read_bytes()).hexdigest(), "pages": pages}
(project / "src/fixtures.json").write_text(json.dumps(fixtures, ensure_ascii=False), encoding="utf-8")

for name in ("button", "badge", "tabs", "textarea"):
    url = f"https://ui.shadcn.com/r/styles/new-york/{name}.json"
    registry = json.load(urllib.request.urlopen(url))
    for file in registry["files"]:
        target = project / "src/components" / file["path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(file["content"], encoding="utf-8")
print("Prepared 3 source-page previews and 4 official shadcn/ui components; original inputs unchanged.")
