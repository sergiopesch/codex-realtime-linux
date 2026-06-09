const GEOCODING_API_URL = 'https://geocoding-api.open-meteo.com/v1/search'
const WEATHER_API_URL = 'https://api.open-meteo.com/v1/forecast'
const DEFAULT_TIMEOUT_MS = 8000
const MAX_TIMEOUT_MS = 120_000
const MAX_LOCATION_QUERY_LENGTH = 160
const MAX_LOCATION_LABEL_LENGTH = 160
const MAX_TIMEZONE_LENGTH = 120
const MAX_WEATHER_TIME_LENGTH = 80
const MAX_WEATHER_SUMMARY_LENGTH = 500
const MAX_UPSTREAM_REASON_LENGTH = 300
const MAX_WEATHER_RESPONSE_BYTES = 256 * 1024

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
  if (typeof location !== 'string') {
    throw new WeatherServiceError('Provide a location with at least 2 characters.', {
      code: 'weather_invalid_location',
      status: 400,
    })
  }

  const query = location.trim().replace(/\s+/g, ' ')
  if (query.length < 2) {
    throw new WeatherServiceError('Provide a location with at least 2 characters.', {
      code: 'weather_invalid_location',
      status: 400,
    })
  }

  if (query.length > MAX_LOCATION_QUERY_LENGTH) {
    throw new WeatherServiceError('Location is too long.', {
      code: 'weather_invalid_location',
      status: 400,
    })
  }
  return query
}

function normalizeUnits(units) {
  if (units == null || units === '') return 'metric'
  if (units === 'metric' || units === 'imperial') return units

  throw new WeatherServiceError('Units must be either "metric" or "imperial".', {
    code: 'weather_invalid_units',
    status: 400,
  })
}

function normalizeTimeoutMs(value) {
  const timeoutMs = Number(value ?? DEFAULT_TIMEOUT_MS)
  return Number.isInteger(timeoutMs) && timeoutMs >= 1_000 && timeoutMs <= MAX_TIMEOUT_MS ? timeoutMs : DEFAULT_TIMEOUT_MS
}

function weatherCodeLabel(code) {
  return WEATHER_CODE_LABELS.get(code) ?? 'Current conditions unavailable'
}

function normalizedWeatherCode(value) {
  return Number.isInteger(value) ? value : null
}

function boundedString(value, fallback = '', maxLength = 1_000) {
  const text = typeof value === 'string' && value.trim() ? value.trim() : fallback
  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`
}

function formatLocationName(location) {
  return [location?.name, location?.admin1, location?.country]
    .map((value) => boundedString(value, '', MAX_LOCATION_LABEL_LENGTH))
    .filter((value, index, all) => value && all.indexOf(value) === index)
    .join(', ')
}

function formatNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10) / 10 : null
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function isValidLatitude(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= -90 && value <= 90
}

function isValidLongitude(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= -180 && value <= 180
}

async function readBoundedResponseText(response, stage) {
  if (!response.body) return ''

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let totalBytes = 0
  let text = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      totalBytes += value.byteLength
      if (totalBytes > MAX_WEATHER_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {})
        throw new WeatherServiceError('The weather service response was too large.', {
          code: `weather_${stage}_response_too_large`,
          status: 502,
        })
      }

      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
    return text
  } finally {
    reader.releaseLock()
  }
}

async function readJson(response, stage) {
  try {
    const text = await readBoundedResponseText(response, stage)
    return text ? JSON.parse(text) : {}
  } catch (error) {
    if (error instanceof WeatherServiceError) throw error
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
        ? boundedString(data.reason, '', MAX_UPSTREAM_REASON_LENGTH)
        : typeof data?.error?.message === 'string'
          ? boundedString(data.error.message, '', MAX_UPSTREAM_REASON_LENGTH)
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

  return boundedString(pieces.join(', '), 'Current weather is available.', MAX_WEATHER_SUMMARY_LENGTH)
}

export async function getCurrentWeather(locationQuery, options = {}) {
  const location = normalizeLocationQuery(locationQuery)
  const unitsMode = normalizeUnits(options.units)
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs)

  const geocodingUrl = new URL(GEOCODING_API_URL)
  geocodingUrl.searchParams.set('name', location)
  geocodingUrl.searchParams.set('count', '1')
  geocodingUrl.searchParams.set('language', 'en')
  geocodingUrl.searchParams.set('format', 'json')

  const geocoding = await fetchJson(geocodingUrl, { fetchImpl, timeoutMs, stage: 'geocoding' })
  const resolvedLocation = Array.isArray(geocoding?.results) ? geocoding.results[0] : null

  const latitude = finiteNumber(resolvedLocation?.latitude)
  const longitude = finiteNumber(resolvedLocation?.longitude)
  if (!resolvedLocation?.name || !isValidLatitude(latitude) || !isValidLongitude(longitude)) {
    throw new WeatherServiceError(`No weather location matched "${location}".`, {
      code: 'weather_location_not_found',
      status: 404,
    })
  }

  const weatherUrl = new URL(WEATHER_API_URL)
  weatherUrl.searchParams.set('latitude', String(latitude))
  weatherUrl.searchParams.set('longitude', String(longitude))
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
  if (!current || finiteNumber(current.temperature_2m) == null) {
    throw new WeatherServiceError('The weather service did not return current conditions.', {
      code: 'weather_missing_current_conditions',
      status: 502,
    })
  }
  const weatherCode = normalizedWeatherCode(current.weather_code)

  const normalized = {
    source: 'open-meteo',
    query: location,
    location: {
      name: boundedString(resolvedLocation.name, 'Unknown location', MAX_LOCATION_LABEL_LENGTH),
      admin1: boundedString(resolvedLocation.admin1, '', MAX_LOCATION_LABEL_LENGTH),
      country: boundedString(resolvedLocation.country, '', MAX_LOCATION_LABEL_LENGTH),
      latitude,
      longitude,
      timezone: boundedString(
        typeof weather?.timezone === 'string' ? weather.timezone : resolvedLocation.timezone,
        '',
        MAX_TIMEZONE_LENGTH,
      ),
    },
    units: {
      mode: unitsMode,
      temperature: unitsMode === 'imperial' ? '°F' : '°C',
      windSpeed: unitsMode === 'imperial' ? 'mph' : 'km/h',
    },
    current: {
      time: boundedString(current.time, new Date().toISOString(), MAX_WEATHER_TIME_LENGTH),
      temperature: formatNumber(current.temperature_2m),
      apparentTemperature: formatNumber(current.apparent_temperature),
      relativeHumidity: formatNumber(current.relative_humidity_2m),
      windSpeed: formatNumber(current.wind_speed_10m),
      weatherCode,
      condition: weatherCodeLabel(weatherCode),
      isDay: current.is_day === 1 ? true : current.is_day === 0 ? false : null,
    },
  }

  return {
    ...normalized,
    summary: buildWeatherSummary(normalized.location, normalized.current, normalized.units),
  }
}
