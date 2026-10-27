#!/usr/bin/env python3
"""Read-only OOXML preservation audit. This script never writes a workbook."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import posixpath
import sys
import xml.etree.ElementTree as ET
from zipfile import ZipFile

N = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"


def local(tag):
    return tag.rsplit("}", 1)[-1]


def tree(node):
    if node is None:
        return None
    return [local(node.tag), dict(sorted(node.attrib.items())), node.text or "", [tree(c) for c in node]]


def resolved_tree(node, relationships):
    result = tree(node)
    if result is None:
        return None
    def resolve(entry):
        if REL in entry[1]:
            entry[1][REL] = relationships[entry[1][REL]]
        for child in entry[3]:
            resolve(child)
    resolve(result)
    return result


def style_table(root):
    fonts = list(root.find("s:fonts", N))
    fills = list(root.find("s:fills", N))
    borders = list(root.find("s:borders", N))
    formats = {int(n.get("numFmtId")): n.get("formatCode") for n in root.findall("s:numFmts/s:numFmt", N)}
    builtins = {0: "General", 1: "0", 2: "0.00", 9: "0%", 10: "0.00%"}
    result = []
    for xf in root.find("s:cellXfs", N):
        fmt_id = int(xf.get("numFmtId", 0))
        alignment = xf.find("s:alignment", N)
        align = dict(alignment.attrib) if alignment is not None else {}
        for k, v in {"horizontal": "general", "vertical": "bottom", "textRotation": "0", "wrapText": "0", "shrinkToFit": "0", "indent": "0", "relativeIndent": "0", "justifyLastLine": "0", "readingOrder": "0"}.items():
            if align.get(k) == v:
                align.pop(k)
        result.append({"font": tree(fonts[int(xf.get("fontId", 0))]), "fill": tree(fills[int(xf.get("fillId", 0))]), "border": tree(borders[int(xf.get("borderId", 0))]), "number_format": formats.get(fmt_id, builtins.get(fmt_id, f"builtin:{fmt_id}")), "alignment": align, "protection": tree(xf.find("s:protection", N))})
    return result


def snapshot(path):
    with ZipFile(path) as z:
        parts = set(z.namelist())
        wb = ET.fromstring(z.read("xl/workbook.xml"))
        rels = {n.get("Id"): n.get("Target") for n in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}
        styles_root = ET.fromstring(z.read("xl/styles.xml"))
        styles = style_table(styles_root)
        strings = []
        if "xl/sharedStrings.xml" in parts:
            strings = ["".join(n.itertext()) for n in ET.fromstring(z.read("xl/sharedStrings.xml"))]
        out = {"sheets": [], "defined_names": tree(wb.find("s:definedNames", N)), "calc_properties": tree(wb.find("s:calcPr", N)), "native_parts": sorted(p for p in parts if any(k in p for k in ("/charts/", "/tables/", "/pivot", "/externalLinks/", "/comments", "/threadedComments")))}
        out["differential_styles"] = tree(styles_root.find("s:dxfs", N))
        differential_styles = [tree(n) for n in styles_root.findall("s:dxfs/s:dxf", N)]
        used_differential_styles = set()
        out["themes"] = {p: tree(ET.fromstring(z.read(p))) for p in parts if p.startswith("xl/theme/") and p.endswith(".xml")}
        out["native_content"] = {p: tree(ET.fromstring(z.read(p))) for p in out["native_parts"] if p.endswith(".xml")}
        for sn in wb.find("s:sheets", N):
            target = rels[sn.get(REL)]
            sheet_path = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join("xl", target))
            root = ET.fromstring(z.read(sheet_path))
            rel_path = posixpath.join(posixpath.dirname(sheet_path), "_rels", posixpath.basename(sheet_path) + ".rels")
            sheet_rels = {n.get("Id"): n.get("Target") for n in ET.fromstring(z.read(rel_path))} if rel_path in parts else {}
            cells = {}
            for c in root.findall("s:sheetData/s:row/s:c", N):
                v, f = c.find("s:v", N), c.find("s:f", N)
                value = None if v is None else v.text
                typ = c.get("t", "n")
                if typ == "s":
                    value, typ = strings[int(value)], "str"
                elif typ == "inlineStr":
                    value, typ = "".join(c.find("s:is", N).itertext()), "str"
                elif typ == "str" and value is None:
                    value = ""
                if typ == "n" and value is not None:
                    value = float(value)
                    if value.is_integer():
                        value = int(value)
                if value == "":
                    value = None
                cells[c.get("r")] = {"value": value, "formula": None if f is None else f.text, "type": typ if value is not None else None, "style": styles[int(c.get("s", 0))]}
            features = {}
            for tag in ("mergeCells", "dataValidations", "autoFilter", "sheetProtection", "protectedRanges", "printOptions", "pageMargins", "pageSetup", "headerFooter", "rowBreaks", "colBreaks", "sheetFormatPr", "sheetPr", "drawing", "legacyDrawing", "tableParts", "hyperlinks"):
                features[tag] = resolved_tree(root.find(f"s:{tag}", N), sheet_rels)
            features["conditionalFormatting"] = [tree(n) for n in root.findall("s:conditionalFormatting", N)]
            rules = [rule for group in features["conditionalFormatting"] for rule in group[3]]
            priorities = {value: index + 1 for index, value in enumerate(sorted({int(rule[1]["priority"]) for rule in rules}))}
            for rule in rules:
                style_id = int(rule[1].pop("dxfId"))
                used_differential_styles.add(style_id)
                rule[1]["differentialStyle"] = differential_styles[style_id]
                rule[1]["priority"] = str(priorities[int(rule[1]["priority"])])
            features["cols"] = [tree(n) for n in root.findall("s:cols/s:col", N)]
            features["rows"] = [dict(n.attrib) for n in root.findall("s:sheetData/s:row", N)]
            features["panes"] = [tree(n) for n in root.findall("s:sheetViews/s:sheetView/s:pane", N)]
            features["view_settings"] = [dict(n.attrib) for n in root.findall("s:sheetViews/s:sheetView", N)]
            out["sheets"].append({"name": sn.get("name"), "state": sn.get("state", "visible"), "cells": cells, "features": features})
        out["unused_differential_styles"] = len(differential_styles) - len(used_differential_styles)
        return out


def conditional_formats(path):
    """Return the template's supported rules as public Artifact Tool configs."""
    result = []
    for sheet in snapshot(path)["sheets"]:
        for group in sheet["features"]["conditionalFormatting"]:
            rules = []
            for rule in group[3]:
                attr = rule[1]
                if attr["type"] != "containsText" or set(attr) != {"operator", "priority", "text", "type", "differentialStyle"}:
                    raise ValueError("Unsupported template conditional format; refusing to approximate it")
                config = {"text": attr["text"], "format": {}}
                for element in attr["differentialStyle"][3]:
                    if element[0] == "fill":
                        pattern = element[3][0]
                        if pattern[1] != {"patternType": "solid"} or len(pattern[3]) != 1 or pattern[3][0][0] != "bgColor":
                            raise ValueError("Unsupported template differential fill")
                        rgb = pattern[3][0][1]["rgb"]
                        if not rgb.startswith("FF"):
                            raise ValueError("Unsupported transparent differential color")
                        config["format"]["fill"] = {"type": "solid", "color": "#" + rgb[2:]}
                    elif element[0] == "font":
                        font = {}
                        for prop in element[3]:
                            if prop[0] == "b" and not prop[1]:
                                font["bold"] = True
                            elif prop[0] == "color" and set(prop[1]) == {"rgb"} and prop[1]["rgb"].startswith("FF"):
                                font["color"] = "#" + prop[1]["rgb"][2:]
                            else:
                                raise ValueError("Unsupported template differential font")
                        config["format"]["font"] = font
                    else:
                        raise ValueError("Unsupported template differential style")
                rules.append({"type": attr["type"], "config": config})
            result.append({"sheet": sheet["name"], "range": group[1]["sqref"], "rules": rules})
    return result


def main():
    if sys.argv[1] == "--conditional-formatting":
        print(json.dumps(conditional_formats(Path(sys.argv[2])), ensure_ascii=False))
        return 0
    baseline, execution, edit_path, audit_path = map(Path, sys.argv[1:])
    before, after = snapshot(baseline), snapshot(execution)
    edits = {(e["sheet"], e["address"]): e for e in json.loads(edit_path.read_text())}
    defects, feature_diffs, style_diffs, permitted_layout_changes = [], [], [], []
    if [(s["name"], s["state"]) for s in before["sheets"]] != [(s["name"], s["state"]) for s in after["sheets"]]:
        defects.append("Sheet order/name/visibility differs")
    formula_count = 0
    unaffected_cells = 0
    recalculated_formulas = 0
    for old, new in zip(before["sheets"], after["sheets"]):
        name = old["name"]
        for address, cell in old["cells"].items():
            current = new["cells"].get(address)
            if current is None:
                defects.append(f"Missing original cell: {name}!{address}")
                continue
            if cell["formula"] != current["formula"]:
                defects.append(f"Formula changed: {name}!{address}")
            if cell["formula"] is not None:
                formula_count += 1
                if current["value"] is not None:
                    recalculated_formulas += 1
            else:
                edit = edits.get((name, address))
                expected = edit["after"] if edit else cell["value"]
                if expected != current["value"]:
                    defects.append(f"Unexpected value: {name}!{address}")
                if not edit:
                    unaffected_cells += 1
            if cell["style"] != current["style"]:
                style_diffs.append({"sheet": name, "cell": address, "before": cell["style"], "after": current["style"]})
            if current["type"] == "e":
                defects.append(f"Formula error: {name}!{address}={current['value']}")
        for address, cell in new["cells"].items():
            if address not in old["cells"] and (cell["value"] is not None or cell["formula"] is not None):
                defects.append(f"Unexpected populated cell: {name}!{address}")
        for tag in old["features"]:
            if tag == "rows":
                expected_rows = [dict(row) for row in old["features"][tag]]
                for row in expected_rows:
                    edited = [e for (sheet, address), e in edits.items() if sheet == name and address == "Q" + row["r"] and "row_height_after" in e]
                    if edited:
                        edit = edited[0]
                        if edit["row_height_before"] != float(row["ht"]) or edit["row_height_after"] < edit["row_height_before"]:
                            defects.append(f"Invalid note height change: {name}!Q{row['r']}")
                        if edit["row_height_after"] != edit["row_height_before"]:
                            permitted_layout_changes.append({"sheet": name, "row": int(row["r"]), "before": edit["row_height_before"], "after": edit["row_height_after"]})
                        row["ht"] = str(edit["row_height_after"])
                expected_rows = [{**row, "ht": float(row["ht"])} if "ht" in row else row for row in expected_rows]
                actual_rows = [{**row, "ht": float(row["ht"])} if "ht" in row else row for row in new["features"][tag]]
                if expected_rows != actual_rows:
                    feature_diffs.append({"sheet": name, "feature": tag, "before": expected_rows, "after": actual_rows})
                continue
            if old["features"][tag] != new["features"][tag]:
                feature_diffs.append({"sheet": name, "feature": tag, "before": old["features"][tag], "after": new["features"][tag]})
    for tag in ("defined_names", "calc_properties", "native_parts", "native_content", "themes"):
        if before[tag] != after[tag]:
            feature_diffs.append({"feature": tag, "before": before[tag], "after": after[tag]})
    repo = Path(__file__).resolve().parents[1]
    spec = json.loads((repo / "docs/video-ingestion/spec/tasks.baseline.json").read_text())
    ledger_bytes = (repo / "docs/video-ingestion/PROGRESS.json").read_bytes()
    ledger = json.loads(ledger_bytes)
    result_sheets = {s["name"]: s["cells"] for s in after["sheets"]}
    verified_results = 0

    def check(sheet, address, expected):
        nonlocal verified_results
        actual = result_sheets[sheet][address]["value"]
        equal = abs(actual - expected) < 1e-9 if isinstance(actual, (int, float)) and isinstance(expected, (int, float)) else actual == expected
        if not equal:
            defects.append(f"Ledger/calculation mismatch: {sheet}!{address}: {actual!r} != {expected!r}")
        verified_results += 1

    task_rows = {result_sheets["开发任务"][f"A{r}"]["value"]: r for r in range(7, 114)}
    for task in spec["tasks"]:
        row, state = task_rows[task["id"]], ledger["tasks"][task["id"]]
        for col, field in (("G", "owner"), ("H", "status"), ("P", "issue")):
            check("开发任务", f"{col}{row}", state[field] or None)
        pending = sum(ledger["tasks"][dep]["status"] != "已完成" for dep in task["deps"])
        check("开发任务", f"K{row}", pending)
        status = state["status"]
        advancement = "已完成" if status == "已完成" else "后续规划" if task["phase"] == "P2" else "处理阻塞" if status == "阻塞" else "已暂停" if status == "暂停" else "等待依赖" if pending else "待指派" if not state["owner"] else "待验收" if status == "待验收" else "可推进"
        check("开发任务", f"L{row}", advancement)
    ac_rows = {result_sheets["端到端用例"][f"A{r}"]["value"]: r for r in range(7, 37)}
    for case in spec["acceptance"]:
        row, state = ac_rows[case["id"]], ledger["acceptance"][case["id"]]
        check("端到端用例", f"H{row}", state["status"])
        check("端到端用例", f"I{row}", state["reviewer"] or None)
    for row, phase in ((9, "P0"), (10, "P1"), (11, "P2")):
        selected = [t for t in spec["tasks"] if t["phase"] == phase]
        complete = sum(ledger["tasks"][t["id"]]["status"] == "已完成" for t in selected)
        for col, expected in (("B", len(selected)), ("C", sum(t["days"] for t in selected)), ("E", complete), ("F", complete / len(selected))):
            check("交付总览", f"{col}{row}", expected)
    for row in range(17, 27):
        module = result_sheets["交付总览"][f"A{row}"]["value"]
        selected = [t for t in spec["tasks"] if t["module"] == module and t["phase"] in {"P0", "P1"}]
        complete = sum(ledger["tasks"][t["id"]]["status"] == "已完成" for t in selected)
        for col, expected in (("B", sum(t["phase"] == "P0" for t in selected)), ("C", sum(t["phase"] == "P1" for t in selected)), ("D", sum(t["days"] for t in selected)), ("E", complete), ("F", complete / len(selected))):
            check("交付总览", f"{col}{row}", expected)
    for row, milestone in enumerate(spec["milestones"], 30):
        selected = [t for t in spec["tasks"] if t["milestone"] == milestone[0]]
        for col, expected in (("C", len(selected)), ("D", sum(t["days"] for t in selected)), ("E", sum(ledger["tasks"][t["id"]]["status"] == "已完成" for t in selected))):
            check("交付总览", f"{col}{row}", expected)
    v1_cases = [c for c in spec["acceptance"] if c["phase"] in {"P0", "P1"}]
    passed = sum(ledger["acceptance"][c["id"]]["status"] == "通过" for c in v1_cases)
    for address, expected in (("B39", len(v1_cases)), ("D39", passed), ("F39", len(v1_cases) - passed)):
        check("交付总览", address, expected)
    report = {"valid": not defects and not style_diffs and not feature_diffs, "baseline_sha256": hashlib.sha256(baseline.read_bytes()).hexdigest(), "execution_sha256": hashlib.sha256(execution.read_bytes()).hexdigest(), "sheets": len(before["sheets"]), "formulas_preserved": formula_count, "formula_cached_values": recalculated_formulas, "unaffected_cells_preserved": unaffected_cells, "expected_edits": len(edits), "defects": defects, "style_differences": style_diffs, "native_feature_differences": feature_diffs, "permitted_note_row_height_changes": permitted_layout_changes}
    report.update(ledger_sha256=hashlib.sha256(ledger_bytes).hexdigest(), independently_verified_results=verified_results)
    report["serialization_notes"] = {"comparison": "Relationships resolved to targets; conditional styles resolved by rule; relative rule priority preserved.", "unused_differential_styles_before": before["unused_differential_styles"], "unused_differential_styles_after": after["unused_differential_styles"]}
    audit_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({k: v for k, v in report.items() if k not in {"style_differences", "native_feature_differences", "permitted_note_row_height_changes"}} | {"style_difference_count": len(style_diffs), "native_feature_difference_count": len(feature_diffs), "note_row_height_changes": len(permitted_layout_changes)}, ensure_ascii=False))
    return 0 if report["valid"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
