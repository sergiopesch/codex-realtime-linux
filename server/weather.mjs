const GEOCODING_API_URL = 'https://geocoding-api.open-meteo.com/v1/search'
const WEATHER_API_URL = 'https://api.open-meteo.com/v1/forecast'
const DEFAULT_TIMEOUT_MS = 8000

const WEATHER_CODE_LABELS = new Map([
  [0, 'Clear sky'],
  [1, 'Mainly clear'],
  [2, 'Partly cloudy'],
  [3, 'Overcast'],
  [45, 'Fog'],
  [48, 'Depositing rime fog'],
  [51, 'Light drizzle'],
  [53, 'Moderate drizzle'],
  [55, 'Dense drizzle'],
  [56, 'Light freezing drizzle'],
  [57, 'Dense freezing drizzle'],
  [61, 'Slight rain'],
  [63, 'Moderate rain'],
  [65, 'Heavy rain'],
  [66, 'Light freezing rain'],
  [67, 'Heavy freezing rain'],
  [71, 'Slight snow'],
  [73, 'Moderate snow'],
  [75, 'Heavy snow'],
  [77, 'Snow grains'],
  [80, 'Slight rain showers'],
  [81, 'Moderate rain showers'],
  [82, 'Violent rain showers'],
  [85, 'Slight snow showers'],
  [86, 'Heavy snow showers'],
  [95, 'Thunderstorm'],
  [96, 'Thunderstorm with slight hail'],
  [99, 'Thunderstorm with heavy hail'],
])

export class WeatherServiceError extends Error {
  constructor(message, { code = 'weather_error', status = 500, cause } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'WeatherServiceError'
    this.code = code
    this.status = status
  }
}

function normalizeLocationQuery(location) {
  if (typeof location !== 'string' || location.trim().length < 2) {
    throw new WeatherServiceError('Provide a location with at least 2 characters.', {
      code: 'weather_invalid_location',
      status: 400,
    })
  }

  return location.trim()
}

function normalizeUnits(units) {
  if (units == null || units === '') return 'metric'
  if (units === 'metric' || units === 'imperial') return units

  throw new WeatherServiceError('Units must be either "metric" or "imperial".', {
    code: 'weather_invalid_units',
    status: 400,
  })
}

function weatherCodeLabel(code) {
  return WEATHER_CODE_LABELS.get(code) ?? 'Current conditions unavailable'
}

function formatLocationName(location) {
  return [location?.name, location?.admin1, location?.country]
    .filter((value, index, all) => typeof value === 'string' && value.trim() && all.indexOf(value) === index)
    .join(', ')
}

function formatNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10) / 10 : null
}

async function readJson(response, stage) {
  try {
    return await response.json()
  } catch (error) {
    throw new WeatherServiceError(`The weather service returned invalid ${stage} data.`, {
      code: `weather_${stage}_invalid_json`,
      status: 502,
      cause: error,
    })
  }
}

async function fetchJson(url, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, stage }) {
  let response
  try {
    response = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const isTimeout = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
    throw new WeatherServiceError(
      isTimeout
        ? 'The weather service took too long to respond.'
        : 'Unable to reach the weather service right now.',
      {
        code: `weather_${stage}_network_error`,
        status: 502,
        cause: error,
      },
    )
  }

  const data = await readJson(response, stage)
  if (!response.ok) {
    const reason =
      typeof data?.reason === 'string'
        ? data.reason
        : typeof data?.error?.message === 'string'
          ? data.error.message
          : null
    throw new WeatherServiceError(
      reason ? `Weather service request failed: ${reason}` : 'Weather service request failed.',
      {
        code: `weather_${stage}_api_error`,
        status: 502,
      },
    )
  }

  return data
}

function buildWeatherSummary(location, current, units) {
  const pieces = [`${formatLocationName(location)}: ${current.temperature}${units.temperature}`]

  if (current.condition) {
    pieces.push(current.condition.toLowerCase())
  }

  if (current.apparentTemperature != null) {
    pieces.push(`feels like ${current.apparentTemperature}${units.temperature}`)
  }

  if (current.windSpeed != null) {
    pieces.push(`wind ${current.windSpeed} ${units.windSpeed}`)
  }

  if (current.relativeHumidity != null) {
    pieces.push(`humidity ${current.relativeHumidity}%`)
  }

  return pieces.join(', ')
}

export async function getCurrentWeather(locationQuery, options = {}) {
  const location = normalizeLocationQuery(locationQuery)
  const unitsMode = normalizeUnits(options.units)
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const geocodingUrl = new URL(GEOCODING_API_URL)
  geocodingUrl.searchParams.set('name', location)
  geocodingUrl.searchParams.set('count', '1')
  geocodingUrl.searchParams.set('language', 'en')
  geocodingUrl.searchParams.set('format', 'json')

  const geocoding = await fetchJson(geocodingUrl, { fetchImpl, timeoutMs, stage: 'geocoding' })
  const resolvedLocation = Array.isArray(geocoding?.results) ? geocoding.results[0] : null

  if (!resolvedLocation?.name || typeof resolvedLocation.latitude !== 'number' || typeof resolvedLocation.longitude !== 'number') {
    throw new WeatherServiceError(`No weather location matched "${location}".`, {
      code: 'weather_location_not_found',
      status: 404,
    })
  }

  const weatherUrl = new URL(WEATHER_API_URL)
  weatherUrl.searchParams.set('latitude', String(resolvedLocation.latitude))
  weatherUrl.searchParams.set('longitude', String(resolvedLocation.longitude))
  weatherUrl.searchParams.set(
    'current',
    [
      'temperature_2m',
      'apparent_temperature',
      'relative_humidity_2m',
      'weather_code',
      'wind_speed_10m',
      'is_day',
    ].join(','),
  )
  weatherUrl.searchParams.set('timezone', 'auto')
  weatherUrl.searchParams.set('forecast_days', '1')
  weatherUrl.searchParams.set('temperature_unit', unitsMode === 'imperial' ? 'fahrenheit' : 'celsius')
  weatherUrl.searchParams.set('wind_speed_unit', unitsMode === 'imperial' ? 'mph' : 'kmh')

  const weather = await fetchJson(weatherUrl, { fetchImpl, timeoutMs, stage: 'forecast' })
  const current = weather?.current
  if (!current || typeof current.temperature_2m !== 'number') {
    throw new WeatherServiceError('The weather service did not return current conditions.', {
      code: 'weather_missing_current_conditions',
      status: 502,
    })
  }

  const normalized = {
    source: 'open-meteo',
    query: location,
    location: {
      name: resolvedLocation.name,
      admin1: resolvedLocation.admin1,
      country: resolvedLocation.country,
      latitude: resolvedLocation.latitude,
      longitude: resolvedLocation.longitude,
      timezone: typeof weather?.timezone === 'string' ? weather.timezone : resolvedLocation.timezone,
    },
    units: {
      mode: unitsMode,
      temperature: unitsMode === 'imperial' ? '°F' : '°C',
      windSpeed: unitsMode === 'imperial' ? 'mph' : 'km/h',
    },
    current: {
      time: typeof current.time === 'string' ? current.time : new Date().toISOString(),
      temperature: formatNumber(current.temperature_2m),
      apparentTemperature: formatNumber(current.apparent_temperature),
      relativeHumidity: formatNumber(current.relative_humidity_2m),
      windSpeed: formatNumber(current.wind_speed_10m),
      weatherCode: typeof current.weather_code === 'number' ? current.weather_code : null,
      condition: weatherCodeLabel(current.weather_code),
      isDay: current.is_day === 1 ? true : current.is_day === 0 ? false : null,
    },
  }

  return {
    ...normalized,
    summary: buildWeatherSummary(normalized.location, normalized.current, normalized.units),
  }
}
