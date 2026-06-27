"""Stream widget — returns the configured URL so the frontend can play it directly."""


async def fetch(widget: dict, data_source: dict | None) -> dict:
    url = widget.get("config", {}).get("stream_url", "")
    if not url:
        return {"error": "No stream URL configured"}
    return {"url": url}
