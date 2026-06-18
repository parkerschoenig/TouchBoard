"""Weather integration using Open-Meteo (free, no API key required).

Widget config:
  {
    "location_name": "New York",
    "latitude": 40.7128,
    "longitude": -74.0060,
    "units": "fahrenheit"   # or "celsius"
  }
"""
import httpx

_BASE = "https://api.open-meteo.com/v1/forecast"
_TIMEOUT = 10.0

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


async def fetch(widget: dict, data_source: dict | None) -> dict:
    cfg = widget.get("config", {})
    lat = cfg.get("latitude")
    lon = cfg.get("longitude")
    if lat is None or lon is None:
        return {"error": "latitude and longitude are required"}

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

    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        resp = await client.get(_BASE, params=params)
        resp.raise_for_status()
        raw = resp.json()

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

    return {
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
