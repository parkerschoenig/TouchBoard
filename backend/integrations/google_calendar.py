"""Google Calendar integration — fetches the private ICS feed (no OAuth needed).

Recurring events (RRULE) are expanded into their upcoming occurrences via
python-dateutil, so monthly bills, paydays, etc. show on the right dates rather
than only on the series' original (often long-past) start date.
"""
import re
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import httpx
from dateutil.rrule import rrulestr

_TIMEOUT = 12.0


def _unfold(text: str) -> str:
    return re.sub(r"\r?\n[ \t]", "", text)


def _unescape(val: str) -> str:
    """Unescape ICS TEXT values (RFC 5545 §3.3.11)."""
    return (
        val.replace("\\n", "\n").replace("\\N", "\n")
        .replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\")
    )


def _resolve_tz(tzid: str | None) -> timezone | ZoneInfo:
    """Resolve a TZID param to a tzinfo, falling back to UTC if unknown."""
    if tzid:
        try:
            return ZoneInfo(tzid)
        except Exception:
            pass
    return timezone.utc


def _parse_dt(val: str, all_day: bool = False, tzid: str | None = None) -> str:
    val = val.strip()
    if all_day:
        try:
            return datetime.strptime(val, "%Y%m%d").date().isoformat()
        except ValueError:
            return val
    try:
        dt = datetime.strptime(val, "%Y%m%dT%H%M%SZ")
        return dt.replace(tzinfo=timezone.utc).isoformat()
    except ValueError:
        pass
    try:
        dt = datetime.strptime(val, "%Y%m%dT%H%M%S")
        # A bare local time only means UTC if no TZID param was given.
        return dt.replace(tzinfo=_resolve_tz(tzid)).isoformat()
    except ValueError:
        pass
    return val


def _dtstart_to_dt(raw: str, all_day: bool, tzid: str | None = None) -> datetime | None:
    """Parse a raw DTSTART value into a datetime for rrule expansion.

    All-day → naive midnight datetime. Timed → aware datetime (UTC, or the
    event's own TZID zone if one was specified).
    """
    raw = raw.strip()
    if all_day:
        try:
            return datetime.strptime(raw, "%Y%m%d")
        except ValueError:
            return None
    try:
        dt = datetime.strptime(raw, "%Y%m%dT%H%M%SZ")
        return dt.replace(tzinfo=timezone.utc)
    except ValueError:
        pass
    try:
        dt = datetime.strptime(raw, "%Y%m%dT%H%M%S")
        return dt.replace(tzinfo=_resolve_tz(tzid))
    except ValueError:
        pass
    return None


async def fetch(widget: dict, data_source: dict | None) -> dict:
    if not data_source:
        return {"error": "No Google Calendar data source configured"}

    creds = data_source.get("credentials") or {}
    # Support both legacy ical_url (single) and ical_urls (multi-line)
    raw = creds.get("ical_urls") or creds.get("ical_url") or ""
    urls = [u.strip() for u in raw.splitlines() if u.strip()]

    if not urls:
        return {"error": "No ICS URL set — paste the private ICS address from Google Calendar settings"}

    cfg = widget.get("config", {})
    days_ahead = max(1, min(90, int(cfg.get("days_ahead") or 7)))
    max_events = max(1, min(50, int(cfg.get("max_events") or 10)))

    # Fetch and merge all ICS feeds
    raw_events: list[dict] = []
    feed_errors: list[str] = []
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        for url in urls:
            try:
                r = await client.get(url)
                r.raise_for_status()
                raw_events.extend(_parse_ics_raw(r.text))
            except Exception as exc:
                feed_errors.append(f"{url[:60]}… → {exc}")

    expanded = _expand_recurring(raw_events, days_ahead)
    events = _filter_and_sort(expanded, days_ahead, max_events)
    result: dict = {"events": events}
    if feed_errors:
        result["feed_errors"] = feed_errors
    return result


def _parse_ics_raw(text: str) -> list[dict]:
    """Parse all VEVENT blocks from an ICS string without date filtering."""
    text = _unfold(text)
    events: list[dict] = []
    in_event = False
    ev: dict = {}

    for line in text.splitlines():
        if line == "BEGIN:VEVENT":
            in_event = True
            ev = {}
        elif line == "END:VEVENT":
            if in_event and ev.get("start"):
                events.append(ev)
            in_event = False
        elif in_event and ":" in line:
            raw_key, _, val = line.partition(":")
            base_key = raw_key.split(";")[0].upper()
            params = raw_key.split(";")[1:]
            is_date_only = any("VALUE=DATE" in p for p in params)
            tzid = next((p.split("=", 1)[1] for p in params if p.upper().startswith("TZID=")), None)

            if base_key == "SUMMARY":
                ev["title"] = _unescape(val)
            elif base_key == "DTSTART":
                ev["all_day"] = is_date_only
                ev["start"] = _parse_dt(val, all_day=is_date_only, tzid=tzid)
                ev["_dtstart_raw"] = val.strip()
                ev["_dtstart_tzid"] = tzid
            elif base_key == "DTEND":
                ev["end"] = _parse_dt(val, all_day=is_date_only, tzid=tzid)
            elif base_key == "RRULE":
                ev["_rrule"] = val.strip()
            elif base_key == "EXDATE":
                exdates = ev.setdefault("_exdates", set())
                for part in val.split(","):
                    exdates.add(part.strip()[:8])  # YYYYMMDD prefix
            elif base_key == "STATUS" and val.strip() == "CANCELLED":
                ev["cancelled"] = True

    return events


def _expand_recurring(events: list[dict], days_ahead: int) -> list[dict]:
    """Expand RRULE events into individual occurrences within the upcoming window."""
    now = datetime.now(timezone.utc)
    win_start = now - timedelta(days=1)
    win_end = now + timedelta(days=days_ahead + 1)

    out: list[dict] = []
    for ev in events:
        rrule = ev.get("_rrule")
        if not rrule:
            out.append(ev)
            continue

        base = _dtstart_to_dt(ev.get("_dtstart_raw", ""), ev.get("all_day", False), ev.get("_dtstart_tzid"))
        if base is None:
            out.append(ev)
            continue

        # All-day expansion happens in naive space; timed in aware UTC space.
        if ev.get("all_day"):
            ws, we = win_start.replace(tzinfo=None), win_end.replace(tzinfo=None)
        else:
            ws, we = win_start, win_end

        try:
            rule = rrulestr(rrule, dtstart=base)
            occurrences = rule.between(ws, we, inc=True)
        except Exception:
            out.append(ev)
            continue

        exdates = ev.get("_exdates") or set()
        for occ in occurrences:
            if occ.strftime("%Y%m%d") in exdates:
                continue
            new = dict(ev)
            if ev.get("all_day"):
                new["start"] = occ.date().isoformat()
            else:
                new["start"] = occ.isoformat()
            out.append(new)

    return out


def _filter_and_sort(events: list[dict], days_ahead: int, max_events: int) -> list[dict]:
    """Filter to the upcoming window, sort, deduplicate, and cap."""
    now = datetime.now(timezone.utc)
    # All-day events use midnight UTC; compare against today's midnight so today's events always show
    today_midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    cutoff = today_midnight + timedelta(days=days_ahead)
    seen: set[str] = set()
    filtered = []

    for ev in events:
        if ev.get("cancelled"):
            continue
        try:
            start_str = ev["start"]
            if ev.get("all_day"):
                start_dt = datetime.fromisoformat(start_str).replace(tzinfo=timezone.utc)
                lower = today_midnight
            else:
                start_dt = datetime.fromisoformat(start_str)
                if start_dt.tzinfo is None:
                    start_dt = start_dt.replace(tzinfo=timezone.utc)
                lower = now
            if start_dt < lower or start_dt > cutoff:
                continue
        except (ValueError, TypeError):
            continue

        key = f"{ev.get('start','')}-{ev.get('title','')}"
        if key in seen:
            continue
        seen.add(key)

        ev.setdefault("title", "(No title)")
        # Strip internal parsing fields before returning to the frontend
        filtered.append({k: v for k, v in ev.items() if not k.startswith("_")})

    # Secondary sort by title: Google serves ICS VEVENTs in a different order on
    # every request, so same-day all-day events (identical "start") would otherwise
    # reshuffle on each refresh. Title gives a stable, deterministic order.
    filtered.sort(key=lambda e: (e["start"], e.get("title", "")))
    return filtered[:max_events]
