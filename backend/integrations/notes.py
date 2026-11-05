"""Notes: a text card written in the editor. Nothing to fetch.

Widget config:
  {"text": "## Today\\n- Swap the UPS battery\\n- **Backup** runs at 02:00",
   "size": 1, "align": "left", "tint": "#fde68a"}

The text supports a small Markdown subset (headings, bold, italic, lists,
checkboxes, links), rendered on the client.
"""


async def fetch(widget: dict, data_source: dict | None) -> dict:
    return {"static": True}
