from pathlib import Path
import json
import re

project = Path(__file__).resolve().parents[1]
source = project.parents[1] / "working-project/ieee-1547/raw/ieee1547-document.json"
document = json.loads(source.read_text(encoding="utf-8"))
outline = []
for element in document["texts"]:
    if element["label"] != "section_header":
        continue
    match = re.match(r"^(\d+(?:\.\d+)*)\.?\s+(.+)$", element["text"])
    if not match or not (1 <= int(match.group(1).split(".")[0]) <= 9):
        continue
    number, title = match.groups()
    outline.append({"id": element["self_ref"], "number": number, "title": title,
                    "level": element["level"], "page": element["prov"][0]["page_no"],
                    "parent": number.rsplit(".", 1)[0] if "." in number else None})

header = next(element for element in document["texts"] if element["self_ref"] == "#/texts/158")
annex = next(element for element in document["texts"] if element["text"] == "Annex A")
outline.append({"id": header["self_ref"], "number": "", "title": header["text"],
                "level": header["level"], "page": header["prov"][0]["page_no"], "parent": None, "warning": "머리말 의심"})
outline.append({"id": annex["self_ref"], "number": "Annex A", "title": "", "level": annex["level"],
                "page": annex["prov"][0]["page_no"], "parent": None})
outline.sort(key=lambda row: (row["page"], int(row["id"].split("/")[-1])))
rule = (project.parents[1] / "docs/rules/document-review-v0.1.md").read_text(encoding="utf-8")
stages = [name for _, name in re.findall(r"^### (\d+)\. (.+)$", rule, re.M)]
fixture = {"stages": stages, "outline": outline, "document": document["name"], "pages": len(document["pages"])}
(project / "src/workflow-data.json").write_text(json.dumps(fixture, ensure_ascii=False), encoding="utf-8")
print(f"Prepared {len(stages)} rule stages and {len(outline)} source-derived outline candidates.")
