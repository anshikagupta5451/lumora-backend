// Live skin-relevant conditions for a location, from Open-Meteo's free
// forecast + air-quality APIs (no key, no signup). OpenWeather's free
// "current weather" endpoint (routes/weather.ts) has no UV index or air
// quality, and those two are what actually change day-to-day skincare
// advice, so the daily brief pulls from here instead.
//
// Every field is nullable and the whole call returns null on failure —
// the brief must still work without location permission or network.

const REQUEST_TIMEOUT_MS = 8_000;

export interface SkinConditions {
  temp: number | null; // °C, current
  humidity: number | null; // %, current
  uvNow: number | null;
  uvMax: number | null; // today's peak, local day
  aqi: number | null; // US AQI, current
  pm25: number | null; // µg/m³, current
  condition: string | null; // short label from WMO weather code
}

// WMO weather interpretation codes, collapsed to the few labels the app shows.
function describeWeatherCode(code: number | null | undefined): string | null {
  if (code == null) return null;
  if (code === 0) return "Clear";
  if (code <= 3) return "Partly cloudy";
  if (code <= 48) return "Fog";
  if (code <= 67) return "Rain";
  if (code <= 77) return "Snow";
  if (code <= 82) return "Showers";
  return "Thunderstorm";
}

async function getJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function getSkinConditions(
  lat: number,
  lon: number,
): Promise<SkinConditions | null> {
  const coords = `latitude=${lat}&longitude=${lon}`;
  const [forecast, air] = await Promise.all([
    getJson(
      `https://api.open-meteo.com/v1/forecast?${coords}&current=temperature_2m,relative_humidity_2m,uv_index,weather_code&daily=uv_index_max&timezone=auto&forecast_days=1`,
    ),
    getJson(
      `https://air-quality-api.open-meteo.com/v1/air-quality?${coords}&current=us_aqi,pm2_5`,
    ),
  ]);

  if (!forecast && !air) return null;

  const temp = num(forecast?.current?.temperature_2m);
  const humidity = num(forecast?.current?.relative_humidity_2m);
  const uvNow = num(forecast?.current?.uv_index);
  const uvMax = num(forecast?.daily?.uv_index_max?.[0]);
  const aqi = num(air?.current?.us_aqi);
  const pm25 = num(air?.current?.pm2_5);

  return {
    temp: temp == null ? null : Math.round(temp),
    humidity: humidity == null ? null : Math.round(humidity),
    uvNow: uvNow == null ? null : Math.round(uvNow * 10) / 10,
    uvMax: uvMax == null ? null : Math.round(uvMax * 10) / 10,
    aqi: aqi == null ? null : Math.round(aqi),
    pm25: pm25 == null ? null : Math.round(pm25 * 10) / 10,
    condition: describeWeatherCode(forecast?.current?.weather_code),
  };
}
