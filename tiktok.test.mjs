// Tests fuer die reine Logik in tiktok.mjs. Aufruf: node --test tiktok.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nyZuUtc, offenesFenster, kandidaten, gleichtaktAb, zweiAmTag, schonAufTikTok } from './tiktok.mjs'

const Z = (s) => new Date(s)

test('New Yorker Zeit: Sommerzeit, Winterzeit, Umstellungswoche', () => {
  assert.equal(nyZuUtc(2026, 9, 26, 13, 0).toISOString(), '2026-09-26T17:00:00.000Z')
  assert.equal(nyZuUtc(2026, 10, 31, 19, 0).toISOString(), '2026-10-31T23:00:00.000Z')
  // USA stellen am 01.11.2026 zurueck
  assert.equal(nyZuUtc(2026, 11, 2, 13, 0).toISOString(), '2026-11-02T18:00:00.000Z')
  assert.equal(nyZuUtc(2026, 12, 31, 23, 30).toISOString(), '2027-01-01T04:30:00.000Z')
})

test('Fenster: offen 90 Minuten ab Slot, sonst null', () => {
  const zeiten = ['13:00', '19:00']
  assert.equal(offenesFenster(Z('2026-09-26T16:59:59Z'), zeiten), null)
  assert.equal(offenesFenster(Z('2026-09-26T17:00:00Z'), zeiten).toISOString(), '2026-09-26T17:00:00.000Z')
  assert.equal(offenesFenster(Z('2026-09-26T18:29:59Z'), zeiten).toISOString(), '2026-09-26T17:00:00.000Z')
  assert.equal(offenesFenster(Z('2026-09-26T18:30:00Z'), zeiten), null)
  // 19:00 New York ist 23:00 UTC, das Fenster reicht in den naechsten UTC-Tag
  assert.equal(offenesFenster(Z('2026-09-27T00:10:00Z'), zeiten).toISOString(), '2026-09-26T23:00:00.000Z')
  // Slot kurz vor Mitternacht New York, gefragt nach Mitternacht
  assert.equal(offenesFenster(Z('2026-09-27T04:10:00Z'), ['23:30']).toISOString(), '2026-09-27T03:30:00.000Z')
  // nach der Umstellung liegt 13:00 New York bei 18:00 UTC
  assert.equal(offenesFenster(Z('2026-11-02T17:30:00Z'), zeiten), null)
  assert.equal(offenesFenster(Z('2026-11-02T18:05:00Z'), zeiten).toISOString(), '2026-11-02T18:00:00.000Z')
})

const ig = (id, slug, published_at, tiktok, status = 'published') => ({ id, slug, status, published_at, scheduled_at: published_at, tiktok })
const JETZT = Date.parse('2026-10-05T17:10:00Z')

test('Reihenfolge: Nachschuss nach nr, neue Reels danach nach Instagram-Zeit', () => {
  const q = { entries: [
    ig('neu-b', 'b', '2026-10-01T12:00:00Z', { status: 'ready' }),
    ig('alt-2', 'x2', '2026-09-20T12:00:00Z', { status: 'ready', nr: 2 }),
    ig('neu-a', 'a', '2026-09-30T12:00:00Z', { status: 'ready' }),
    ig('alt-1', 'x1', '2026-09-24T12:00:00Z', { status: 'ready', nr: 1 }),
    ig('ig-offen', 'c', null, { status: 'ready' }, 'ready'),
    ig('angehalten', 'd', '2026-09-30T12:00:00Z', { status: 'draft' }),
    { id: 'ohne', slug: 'e', status: 'published', published_at: '2026-09-30T12:00:00Z' },
  ] }
  const { gleichtakt, nachschuss, ab } = kandidaten(q, JETZT)
  assert.equal(ab, null)
  assert.deepEqual(gleichtakt.map((e) => e.id), [])
  assert.deepEqual(nachschuss.map((e) => e.id), ['alt-1', 'alt-2', 'neu-a', 'neu-b'])
})

test('Gleichtakt erst, wenn die Top 12 durch sind, und nur fuer frische Reels', () => {
  const top = Array.from({ length: 12 }, (_, i) => ig(`t${i + 1}`, `t${i + 1}`, '2026-09-20T12:00:00Z',
    { status: i === 11 ? 'ready' : 'published', nr: i + 1, published_at: `2026-10-0${1 + (i % 3)}T12:00:00Z` }))
  const q = { entries: [
    ...top,
    ig('frisch', 'f', '2026-10-05T17:02:00Z', { status: 'ready' }),
    ig('vorher', 'v', '2026-10-02T12:00:00Z', { status: 'ready' }),
  ] }
  assert.equal(gleichtaktAb(q), null)
  assert.equal(zweiAmTag(q), true)
  assert.deepEqual(kandidaten(q, JETZT).gleichtakt.map((e) => e.id), [])

  top[11].tiktok = { status: 'published', nr: 12, published_at: '2026-10-04T23:00:00Z' }
  assert.equal(gleichtaktAb(q), Date.parse('2026-10-04T23:00:00Z'))
  assert.equal(zweiAmTag(q), false)
  const k = kandidaten(q, JETZT)
  assert.deepEqual(k.gleichtakt.map((e) => e.id), ['frisch'])
  // vor dem Gleichtakt auf Instagram erschienen: bleibt im Nachschuss
  assert.deepEqual(k.nachschuss.map((e) => e.id), ['vorher'])
  // drei Stunden spaeter ist "frisch" nicht mehr frisch und rutscht in den Nachschuss
  assert.deepEqual(kandidaten(q, JETZT + 3 * 3600_000 + 60_000).nachschuss.map((e) => e.id), ['vorher', 'frisch'])
})

test('Fehler und Uebersprungene zaehlen fuer die Top 12 als erledigt', () => {
  const q = { entries: [
    ig('t1', 't1', '2026-09-20T12:00:00Z', { status: 'error', nr: 1, fehler_at: '2026-10-01T10:00:00Z' }),
    ig('t2', 't2', '2026-09-20T12:00:00Z', { status: 'published', nr: 2, published_at: '2026-10-01T12:00:00Z' }),
  ] }
  assert.equal(gleichtaktAb(q), Date.parse('2026-10-01T12:00:00Z'))
  assert.equal(zweiAmTag(q), false)
})

test('Je Slug hoechstens ein TikTok-Post', () => {
  const a = ig('a', 'gleich', '2026-09-20T12:00:00Z', { status: 'published', nr: 1 })
  const b = ig('b', 'gleich', '2026-10-01T12:00:00Z', { status: 'ready' })
  const c = ig('c', 'anders', '2026-10-01T12:00:00Z', { status: 'ready' })
  const q = { entries: [a, b, c] }
  assert.equal(schonAufTikTok(q, b), true)
  assert.equal(schonAufTikTok(q, c), false)
  a.tiktok.status = 'error'
  assert.equal(schonAufTikTok(q, b), false)
})
