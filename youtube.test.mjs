// Tests fuer die reine Logik in youtube.mjs. Aufruf: node --test youtube.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { titelAus, beschreibungAus, kandidaten, schonAufYouTube, letzterStart, uploadsIn24h, marke } from './youtube.mjs'

// Echte Caption aus der Queue (2026-10-25-fuenfzig-dreihundert), gekuerzt.
const CAPTION = `Your target is $50, your stop is $300, and 85 wins in 100 still lose $250.

How? 85 wins at $50 make $4,250.

Your journal, link in bio.

Part 136 of the series.

#stoploss #takeprofit #winrate #daytrading #tradingjournal`

test('Titel: erste Zeile der Caption, ohne Hashtags und spitze Klammern', () => {
  assert.equal(titelAus(CAPTION), 'Your target is $50, your stop is $300, and 85 wins in 100 still lose $250.')
  assert.equal(titelAus('\n\n  Risk <1 %> per trade #risk #trading  \nRest'), 'Risk 1 % per trade')
  assert.equal(titelAus(''), '')
  assert.equal(titelAus(undefined), '')
})

test('Titel: hoechstens 100 Zeichen, am Wortende gekuerzt', () => {
  const lang = 'You doubled your trades from 5 a day to 10, and your +$500 week became −$250, because the extra trades were the setups you used to skip.'
  const t = titelAus(lang)
  assert.ok([...t].length <= 100, `${[...t].length} Zeichen`)
  assert.ok(t.endsWith('…'))
  assert.ok(lang.startsWith(t.slice(0, -1)), 'nur gekuerzt, nichts veraendert')
  assert.ok(!/\s…$/.test(t), 'kein Leerzeichen vor den Auslassungspunkten')
})

test('Beschreibung: "link in bio" wird zur Adresse, sonst bleibt alles', () => {
  const b = beschreibungAus(CAPTION)
  assert.ok(b.includes('Your journal: glanwick.com'))
  assert.ok(!/link in bio/i.test(b))
  assert.ok(b.includes('#tradingjournal'))
  assert.ok(b.startsWith('Your target is $50'))
  // Alte Schlusszeile mit "Free journal" wird genauso ersetzt
  assert.ok(beschreibungAus('A.\n\nFree journal, link in bio.\n\n#x').includes('Your journal: glanwick.com'))
})

test('Beschreibung: Werbung mit "free journal" geht nie raus', () => {
  assert.throws(() => beschreibungAus('Grab the free journal today.'), /free journal/)
  assert.throws(() => beschreibungAus('Journal is in my bio, link in bio above.'), /link in bio/)
  assert.throws(() => beschreibungAus('x'.repeat(5001)), /5\.000/)
})

const e = (id, slug, ig, y, extra = {}) => ({ id, slug, status: ig ? 'published' : 'ready', published_at: ig, youtube: y, ...extra })

test('Kandidaten: nur ready nach dem Instagram-Post, aeltester zuerst', () => {
  const q = { entries: [
    e('b', 'b', '2026-10-26T12:00:00Z', { status: 'ready' }),
    e('a', 'a', '2026-10-26T10:00:00Z', { status: 'ready' }),
    e('c', 'c', null, { status: 'ready' }),
    e('d', 'd', '2026-10-26T09:00:00Z', { status: 'draft' }),
    e('f', 'f', '2026-10-26T08:00:00Z', undefined),
  ] }
  assert.deepEqual(kandidaten(q).map((x) => x.id), ['a', 'b'])
})

test('Doppelter Slug und Zaehlung', () => {
  const jetzt = Date.parse('2026-10-26T12:00:00Z')
  const q = { entries: [
    e('1', 'gleich', '2026-10-25T10:00:00Z', { status: 'published', gestartet_at: '2026-10-26T11:30:00Z' }),
    e('2', 'gleich', '2026-10-26T10:00:00Z', { status: 'ready' }),
    e('3', 'anders', '2026-10-26T10:00:00Z', { status: 'ready', gestartet_at: '2026-10-26T11:50:00Z', fehlversuche: 1 }),
    e('4', 'alt', '2026-10-24T10:00:00Z', { status: 'published', gestartet_at: '2026-10-25T11:00:00Z' }),
  ] }
  assert.equal(schonAufYouTube(q, q.entries[1]), true)
  assert.equal(schonAufYouTube(q, q.entries[2]), false)
  assert.equal(letzterStart(q), Date.parse('2026-10-26T11:50:00Z'), 'Abstand zaehlt auch den Fehlversuch')
  assert.equal(uploadsIn24h(q, jetzt), 1, 'Tagesgrenze zaehlt nur laufende und fertige Uploads der letzten 24 h')
  assert.equal(marke({ id: '2026-10-25-x' }), 'gwq-2026-10-25-x')
})
