"""Weather integration using Open-Meteo (free, no API key required).

Widget config:
  {
    "location_name": "New York",
    "latitude": 40.7128,
    "longitude": -74.0060,
    "units": "fahrenheit"   # or "celsius"
  }
"""
import time
import httpx

_BASE = "https://api.open-meteo.com/v1/forecast"
_TIMEOUT = 10.0
_CACHE_TTL = 600  # 10 minutes

# {"{lat}_{lon}": (monotonic_ts, result)}
_cache: dict[str, tuple[float, dict]] = {}

# WMO weather code → human label
_WMO_LABEL = {
    0: "Clear Sky",
    1: "Mainly Clear", 2: "Partly Cloudy", 3: "Overcast",
    45: "Fog", 48: "Icy Fog",
    51: "Light Drizzle", 53: "Drizzle", 55: "Heavy Drizzle",
    56: "Freezing Drizzle", 57: "Heavy Freezing Drizzle",
    61: "Light Rain", 63: "Rain", 65: "Heavy Rain",
    66: "Freezing Rain", 67: "Heavy Freezing Rain",
    71: "Light Snow", 73: "Snow", 75: "Heavy Snow", 77: "Snow Grains",
    80: "Light Showers", 81: "Showers", 82: "Heavy Showers",
    85: "Light Snow Showers", 86: "Heavy Snow Showers",
    95: "Thunderstorm",
    96: "Thunderstorm w/ Hail", 99: "Thunderstorm w/ Heavy Hail",
}


_DEMO_DATA = {
    "location": "New York",
    "unit": "fahrenheit",
    "wind_unit": "mph",
    "current": {
        "temperature": 72,
        "feels_like": 70,
        "humidity": 58,
        "windspeed": 9.4,
        "weathercode": 2,
        "label": "Partly Cloudy",
    },
    "hourly": [
        {"time": "2025-06-24T14:00", "temperature": 72, "weathercode": 2, "label": "Partly Cloudy", "precip_prob": 10, "windspeed": 9.4},
        {"time": "2025-06-24T15:00", "temperature": 74, "weathercode": 1, "label": "Mainly Clear",  "precip_prob": 5,  "windspeed": 8.1},
        {"time": "2025-06-24T16:00", "temperature": 75, "weathercode": 1, "label": "Mainly Clear",  "precip_prob": 5,  "windspeed": 7.5},
        {"time": "2025-06-24T17:00", "temperature": 73, "weathercode": 2, "label": "Partly Cloudy", "precip_prob": 15, "windspeed": 10.2},
        {"time": "2025-06-24T18:00", "temperature": 70, "weathercode": 3, "label": "Overcast",      "precip_prob": 30, "windspeed": 11.0},
        {"time": "2025-06-24T19:00", "temperature": 67, "weathercode": 61,"label": "Light Rain",    "precip_prob": 55, "windspeed": 12.3},
        {"time": "2025-06-24T20:00", "temperature": 65, "weathercode": 61,"label": "Light Rain",    "precip_prob": 60, "windspeed": 13.1},
        {"time": "2025-06-24T21:00", "temperature": 63, "weathercode": 63,"label": "Rain",          "precip_prob": 70, "windspeed": 14.0},
        {"time": "2025-06-24T22:00", "temperature": 61, "weathercode": 63,"label": "Rain",          "precip_prob": 65, "windspeed": 12.8},
        {"time": "2025-06-24T23:00", "temperature": 60, "weathercode": 61,"label": "Light Rain",    "precip_prob": 45, "windspeed": 11.5},
        {"time": "2025-06-25T00:00", "temperature": 59, "weathercode": 3, "label": "Overcast",      "precip_prob": 25, "windspeed": 9.0},
        {"time": "2025-06-25T01:00", "temperature": 58, "weathercode": 2, "label": "Partly Cloudy", "precip_prob": 10, "windspeed": 7.2},
    ],
    "daily": [
        {"date": "2025-06-24", "weathercode": 61, "label": "Light Rain",    "temp_max": 75, "temp_min": 58, "precip_prob": 70},
        {"date": "2025-06-25", "weathercode": 2,  "label": "Partly Cloudy", "temp_max": 73, "temp_min": 57, "precip_prob": 20},
        {"date": "2025-06-26", "weathercode": 1,  "label": "Mainly Clear",  "temp_max": 78, "temp_min": 60, "precip_prob": 5},
        {"date": "2025-06-27", "weathercode": 0,  "label": "Clear Sky",     "temp_max": 81, "temp_min": 63, "precip_prob": 0},
        {"date": "2025-06-28", "weathercode": 2,  "label": "Partly Cloudy", "temp_max": 79, "temp_min": 62, "precip_prob": 15},
        {"date": "2025-06-29", "weathercode": 3,  "label": "Overcast",      "temp_max": 74, "temp_min": 61, "precip_prob": 35},
        {"date": "2025-06-30", "weathercode": 80, "label": "Light Showers", "temp_max": 70, "temp_min": 59, "precip_prob": 60},
    ],
}


async def fetch(widget: dict, data_source: dict | None) -> dict:
    from ..demo import DEMO_MODE
    if DEMO_MODE:
        return _DEMO_DATA

    cfg = widget.get("config", {})
    lat = cfg.get("latitude")
    lon = cfg.get("longitude")
    if lat is None or lon is None:
        return {"error": "latitude and longitude are required"}

    cache_key = f"{lat}_{lon}"
    now = time.monotonic()
    if cache_key in _cache:
        ts, cached = _cache[cache_key]
        if now - ts < _CACHE_TTL:
            return cached

    units = cfg.get("units", "fahrenheit")
    wind_unit = "mph" if units == "fahrenheit" else "kmh"

    forecast_days = int(cfg.get("forecast_days", 3))
    if forecast_days not in (3, 5, 7):
        forecast_days = 3

    params = {
        "latitude": lat,
        "longitude": lon,
        "current": "temperature_2m,relative_humidity_2m,apparent_temperature,weathercode,windspeed_10m",
        "hourly": "temperature_2m,weathercode,precipitation_probability,windspeed_10m",
        "daily": "weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
        "temperature_unit": units,
        "wind_speed_unit": wind_unit,
        "forecast_days": forecast_days,
        "timezone": "auto",
    }

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.get(_BASE, params=params)
            resp.raise_for_status()
            raw = resp.json()
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 429:
            if cache_key in _cache:
                return _cache[cache_key][1]
            return {"unavailable": True, "location": cfg.get("location_name", f"{lat}, {lon}")}
        raise

    cur    = raw.get("current", {})
    daily  = raw.get("daily", {})
    hourly = raw.get("hourly", {})

    def label(code):
        return _WMO_LABEL.get(code, "Unknown")

    # Build next 12 hours of hourly data starting from the current hour
    import datetime
    now_str = cur.get("time", "")  # e.g. "2024-01-15T14:00"
    hourly_times = hourly.get("time", [])
    hourly_out = []
    if now_str and hourly_times:
        try:
            now_dt = datetime.datetime.fromisoformat(now_str)
            for i, t in enumerate(hourly_times):
                t_dt = datetime.datetime.fromisoformat(t)
                if t_dt >= now_dt:
                    hourly_out.append({
                        "time": t,
                        "temperature": hourly["temperature_2m"][i],
                        "weathercode": hourly["weathercode"][i],
                        "label": label(hourly["weathercode"][i]),
                        "precip_prob": hourly.get("precipitation_probability", [])[i] if i < len(hourly.get("precipitation_probability", [])) else None,
                        "windspeed": hourly.get("windspeed_10m", [])[i] if i < len(hourly.get("windspeed_10m", [])) else None,
                    })
                    if len(hourly_out) >= 12:
                        break
        except (ValueError, IndexError):
            pass

    result = {
        "location": cfg.get("location_name", f"{lat}, {lon}"),
        "unit": units,
        "wind_unit": wind_unit,
        "current": {
            "temperature": cur.get("temperature_2m"),
            "feels_like": cur.get("apparent_temperature"),
            "humidity": cur.get("relative_humidity_2m"),
            "windspeed": cur.get("windspeed_10m"),
            "weathercode": cur.get("weathercode", 0),
            "label": label(cur.get("weathercode", 0)),
        },
        "hourly": hourly_out,
        "daily": [
            {
                "date": daily["time"][i],
                "weathercode": daily["weathercode"][i],
                "label": label(daily["weathercode"][i]),
                "temp_max": daily["temperature_2m_max"][i],
                "temp_min": daily["temperature_2m_min"][i],
                "precip_prob": (daily.get("precipitation_probability_max") or [None] * forecast_days)[i],
            }
            for i in range(min(forecast_days, len(daily.get("time", []))))
        ],
    }
    _cache[cache_key] = (time.monotonic(), result)
    return result
