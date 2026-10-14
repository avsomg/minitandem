"""Extract the 2026 canton municipality list from the official XLSX download."""

import json
import sys
from pathlib import Path

from openpyxl import load_workbook


SOURCE = "https://www.fr.ch/document/580206"
DISTRICTS = {
    "Broyebezirk": "broye",
    "Glanebezirk": "glane",
    "Greyerzbezirk": "gruyere",
    "Saanebezirk": "sarine",
    "Seebezirk": "see",
    "Sensebezirk": "sense",
    "Vivisbachbezirk": "veveyse",
}


def main(source: Path, destination: Path) -> None:
    sheet = load_workbook(source, read_only=True, data_only=True).worksheets[0]
    region = None
    records = []
    expected = 0
    for row in sheet.values:
        number, name = row[1:3]
        if not isinstance(number, int) or not isinstance(name, str):
            continue
        if number < 1000:
            district = next((code for marker, code in DISTRICTS.items() if marker in name), None)
            if district is not None:
                region = district
                expected += number
        else:
            if region is None:
                raise ValueError(f"Municipality without district: {name}")
            records.append({"ofs": number, "name": name, "region": region})
    if len(records) != expected or len(records) != 119:
        raise ValueError(f"Expected 119 municipalities, found {len(records)}; district totals say {expected}")
    payload = {"source": SOURCE, "year": 2026, "count": len(records), "municipalities": records}
    destination.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
