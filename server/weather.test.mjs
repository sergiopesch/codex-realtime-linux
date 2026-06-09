import test from 'node:test'
import assert from 'node:assert/strict'
import { getCurrentWeather, WeatherServiceError } from './weather.mjs'

test('getCurrentWeather returns normalized current conditions', async () => {
  const requests = []
  const fetchImpl = async (url) => {
    requests.push(String(url))

    if (String(url).startsWith('https://geocoding-api.open-meteo.com/')) {
      return Response.json({
        results: [
          {
            name: 'Berlin',
            admin1: 'Berlin',
            country: 'Germany',
            latitude: 52.52,
            longitude: 13.41,
            timezone: 'Europe/Berlin',
          },
        ],
      })
    }

    return Response.json({
      timezone: 'Europe/Berlin',
      current: {
        time: '2026-06-08T10:00',
        temperature_2m: 19.4,
        apparent_temperature: 18.9,
        relative_humidity_2m: 54,
        weather_code: 2,
        wind_speed_10m: 12.2,
        is_day: 1,
      },
    })
  }

  const weather = await getCurrentWeather('Berlin', { fetchImpl })

  assert.equal(requests.length, 2)
  assert.equal(weather.location.name, 'Berlin')
  assert.equal(weather.current.temperature, 19.4)
  assert.equal(weather.current.condition, 'Partly cloudy')
  assert.equal(weather.units.temperature, '°C')
  assert.match(weather.summary, /Berlin, Germany/i)
  assert.match(weather.summary, /Partly cloudy/i)
})

test('getCurrentWeather rejects invalid locations before calling upstream services', async () => {
  await assert.rejects(
    () => getCurrentWeather(' '),
    (error) =>
      error instanceof WeatherServiceError &&
      error.status === 400 &&
      error.code === 'weather_invalid_location',
  )
})

test('getCurrentWeather bounds upstream labels and summaries', async () => {
  const longLabel = 'L'.repeat(400)
  const fetchImpl = async (url) => {
    if (String(url).startsWith('https://geocoding-api.open-meteo.com/')) {
      return Response.json({
        results: [
          {
            name: longLabel,
            admin1: `${longLabel} admin`,
            country: `${longLabel} country`,
            latitude: 52.52,
            longitude: 13.41,
            timezone: longLabel,
          },
        ],
      })
    }

    return Response.json({
      timezone: longLabel,
      current: {
        time: longLabel,
        temperature_2m: 19.4,
        apparent_temperature: 18.9,
        relative_humidity_2m: 54,
        weather_code: 2,
        wind_speed_10m: 12.2,
        is_day: 1,
      },
    })
  }

  const weather = await getCurrentWeather('Berlin', { fetchImpl })

  assert.equal(weather.location.name.length, 160)
  assert.equal(weather.location.admin1.length, 160)
  assert.equal(weather.location.country.length, 160)
  assert.equal(weather.location.timezone.length, 120)
  assert.equal(weather.current.time.length, 80)
  assert.ok(weather.summary.length <= 500)
})

test('getCurrentWeather rejects oversized location queries before calling upstream services', async () => {
  await assert.rejects(
    () => getCurrentWeather('x'.repeat(200)),
    (error) =>
      error instanceof WeatherServiceError &&
      error.status === 400 &&
      error.code === 'weather_invalid_location',
  )
})

test('getCurrentWeather surfaces not-found locations as a 404', async () => {
  const fetchImpl = async () => Response.json({ results: [] })

  await assert.rejects(
    () => getCurrentWeather('Atlantis', { fetchImpl }),
    (error) =>
      error instanceof WeatherServiceError &&
      error.status === 404 &&
      error.code === 'weather_location_not_found',
  )
})

test('getCurrentWeather converts network failures into a graceful upstream error', async () => {
  const fetchImpl = async () => {
    throw new Error('socket hang up')
  }

  await assert.rejects(
    () => getCurrentWeather('Madrid', { fetchImpl }),
    (error) =>
      error instanceof WeatherServiceError &&
      error.status === 502 &&
      error.code === 'weather_geocoding_network_error',
  )
})
