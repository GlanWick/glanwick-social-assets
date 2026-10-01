// Probelauf des echten Waechters (post-due.mjs + tiktok.mjs) gegen nachgebaute
// Server fuer Instagram, Zernio, Telegram und Dateien, in einem Wegwerf-Repo.
// Aufruf (im Repo-Wurzelverzeichnis): node test/waechter-probelauf.mjs [szenario ...]
// Vor jeder Aenderung an post-due.mjs oder tiktok.mjs laufen lassen. Dauer rund 3 Minuten.
// Nichts davon beruehrt Instagram, Zernio oder Telegram: alle drei sind lokal nachgebaut.
import http from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, cpSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const QUELLE = dirname(dirname(fileURLToPath(import.meta.url)))
const KEY = 'sk_test_' + 'a'.repeat(64) // Attrappe, kein echter Schluessel

// ---------------------------------------------------------------- Nachbau
function starteMock() {
  const s = {
    konten: [], verhalten: 'published', calls: [], telegram: [], posts: new Map(), idem: new Map(),
    uploads: [], zaehler: 0, getAufrufe: new Map(),
  }
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const roh = Buffer.concat(chunks)
    const url = new URL(req.url, 'http://x')
    const p = url.pathname
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    let body = null
    try { body = roh.length && (req.headers['content-type'] || '').includes('json') ? JSON.parse(roh) : null } catch {}
    s.calls.push({ m: req.method, p, q: url.search, h: { auth: req.headers.authorization, idem: req.headers['idempotency-key'], ct: req.headers['content-type'] }, body, len: roh.length })

    // Dateien (Release/Pages) und Zernio-Speicher
    if (p.startsWith('/files/')) {
      const name = p.slice(7)
      if (name.includes('fehlt')) { res.writeHead(404); return res.end('Not Found') }
      const groesse = name.endsWith('.mp4') ? 600_000 : 20_000
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': groesse })
      return res.end(Buffer.alloc(groesse, 7))
    }
    if (p.startsWith('/upload/') && req.method === 'PUT') { s.uploads.push({ key: p.slice(8), ct: req.headers['content-type'], len: roh.length }); res.writeHead(200); return res.end() }

    // Telegram
    if (p.startsWith('/tg/')) { s.telegram.push(body?.text || ''); return json(200, { ok: true }) }

    // Instagram
    if (p.startsWith('/ig/')) {
      const r = p.slice(3)
      if (r === '/me/content_publishing_limit') return json(200, { data: [{ quota_usage: 0 }] })
      if (r === '/me/media' && req.method === 'POST') return json(200, { id: `c${++s.zaehler}` })
      if (r === '/me/media_publish') return json(200, { id: `m${s.zaehler}` })
      if (r === '/me/media') return json(200, { data: [] })
      if (r === '/me/insights') return json(200, { data: [{ values: [] }] })
      if (r === '/me') return json(200, { username: 'glanwick_com', followers_count: 226, media_count: 100 })
      if (/^\/c\d+$/.test(r)) return json(200, { status_code: 'FINISHED' })
      if (/^\/m\d+$/.test(r)) return json(200, { permalink: `https://www.instagram.com/reel/TEST${r.slice(2)}/` })
      return json(200, { data: [] })
    }

    // Zernio
    if (p.startsWith('/z/v1/')) {
      if (req.headers.authorization !== `Bearer ${KEY}`) return json(401, { error: 'Unauthorized' })
      const r = p.slice(5)
      if (r === '/accounts') return json(200, { accounts: s.konten })
      if (r === '/media/presign') {
        const key = `k${++s.zaehler}-${body.filename}`
        return json(200, { uploadUrl: `http://127.0.0.1:${s.port}/upload/${key}?sig=GEHEIM`, publicUrl: `https://cdn.zernio.test/${key}`, key, expiresIn: 3600 })
      }
      if (r === '/posts' && req.method === 'POST') {
        const idem = req.headers['idempotency-key']
        if (idem && s.idem.has(idem)) return json(200, { post: s.posts.get(s.idem.get(idem)) })
        const v = s.verhalten
        if (v === '400') return json(400, { error: 'Caption enthaelt verbotene Woerter' })
        if (v === '500') return json(500, { error: 'upstream kaputt' })
        const id = `p${++s.zaehler}`
        const jetzt = new Date().toISOString()
        let post
        if (v === 'published') post = { _id: id, status: 'published', platforms: [{ platform: 'tiktok', status: 'published', platformPostUrl: `https://www.tiktok.com/@glanwick/video/${id}`, platformPostId: id, publishedAt: jetzt }] }
        else if (v === 'pending') post = { _id: id, status: 'publishing', platforms: [{ platform: 'tiktok', status: 'processing', platformPostUrl: null }] }
        else if (v === '207-failed') post = { _id: id, status: 'failed', platforms: [{ platform: 'tiktok', status: 'failed', errorMessage: 'TikTok lehnt ab: Spam' }] }
        s.posts.set(id, post)
        if (idem) s.idem.set(idem, id)
        return json(v === '207-failed' ? 207 : 201, { message: 'ok', post, ...(v === '207-failed' ? { error: 'All platforms failed' } : {}) })
      }
      const m = r.match(/^\/posts\/(p\d+)$/)
      if (m && req.method === 'GET') {
        const post = s.posts.get(m[1])
        if (!post) return json(404, { error: 'not found' })
        // Beim ersten Nachfragen ist ein "processing"-Beitrag fertig
        const pl = post.platforms[0]
        if (pl.status === 'processing') { pl.status = 'published'; pl.platformPostUrl = `https://www.tiktok.com/@glanwick/video/${m[1]}`; pl.platformPostId = m[1]; pl.publishedAt = new Date().toISOString(); post.status = 'published' }
        return json(200, { post })
      }
      return json(404, { error: 'unbekannt ' + r })
    }
    json(404, { error: 'nichts hier' })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => { s.port = server.address().port; resolve({ s, server }) }))
}

// ---------------------------------------------------------------- Wegwerf-Repo
function repoMit(queue, dateien = []) {
  const dir = mkdtempSync(join(tmpdir(), 'waechter-'))
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', join(dir, 'remote.git')])
  execFileSync('git', ['clone', '-q', join(dir, 'remote.git'), join(dir, 'work')], { stdio: 'ignore' })
  const w = join(dir, 'work')
  for (const f of ['post-due.mjs', 'tiktok.mjs']) cpSync(join(QUELLE, f), join(w, f))
  writeFileSync(join(w, 'queue.json'), JSON.stringify(queue, null, 2) + '\n')
  for (const f of dateien) writeFileSync(join(w, f), 'x')
  const g = (...a) => execFileSync('git', a, { cwd: w, encoding: 'utf8' })
  g('config', 'user.name', 'test'); g('config', 'user.email', 't@t')
  g('checkout', '-q', '-b', 'main'); g('add', '-A'); g('commit', '-qm', 'start'); g('push', '-q', 'origin', 'main')
  return { dir, w, remoteQueue: () => JSON.parse(execFileSync('git', ['--git-dir', join(dir, 'remote.git'), 'show', 'main:queue.json'], { encoding: 'utf8' })), remoteHat: (f) => { try { execFileSync('git', ['--git-dir', join(dir, 'remote.git'), 'cat-file', '-e', `main:${f}`]); return true } catch { return false } } }
}

const nyJetzt = () => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(new Date())

function laufe(w, port, { sekunden, key = KEY, env = {} }) {
  return new Promise((resolve) => {
    const kind = spawn('node', ['post-due.mjs'], {
      cwd: w,
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME,
        IG_TOKEN: 'igtest', IG_API_BASE: `http://127.0.0.1:${port}/ig`, ZERNIO_API_BASE: `http://127.0.0.1:${port}/z`,
        ZERNIO_API_KEY: key, TELEGRAM_API_BASE: `http://127.0.0.1:${port}/tg`, TELEGRAM_BOT_TOKEN: 'tgtest', TELEGRAM_CHAT_ID: '1',
        WATCH_MINUTES: String(sekunden / 60), TICK_MS: '1000', TIKTOK_ZEITEN_ZWEI: nyJetzt(), TIKTOK_ZEITEN_EINER: nyJetzt(), ...env,
      },
    })
    let out = ''
    kind.stdout.on('data', (d) => { out += d })
    kind.stderr.on('data', (d) => { out += d })
    kind.on('close', (code) => resolve({ code, out }))
  })
}

// ---------------------------------------------------------------- Testdaten
const vor = (min) => new Date(Date.now() - min * 60_000).toISOString()
const F = (port, name) => `http://127.0.0.1:${port}/files/${name}`
const igEintrag = (port, id, slug, extra = {}) => ({
  id, slug, status: 'published', scheduled_at: vor(60 * 24 * 3), published_at: vor(60 * 24 * 3),
  video_url: `https://glanwick.github.io/glanwick-social-assets/${slug}.mp4`,
  cover_url: `https://glanwick.github.io/glanwick-social-assets/${slug}-cover.jpg`,
  caption: `Caption fuer ${slug}.\n\n#tradingjournal`, ...extra,
})
const tt = (port, slug, extra = {}) => ({ status: 'ready', video_url: F(port, `${slug}.mp4`), cover_url: F(port, `${slug}-cover.jpg`), ...extra })

const szenarien = {}

szenarien['instagram-unveraendert-ohne-schluessel'] = async ({ s }) => {
  const r = repoMit({ entries: [{ ...igEintrag(s.port, 'ig-1', 'reel-a'), status: 'ready', published_at: undefined, scheduled_at: vor(1), tiktok: tt(s.port, 'reel-a') }] }, ['reel-a.mp4', 'reel-a-cover.jpg'])
  const { out } = await laufe(r.w, s.port, { sekunden: 20, key: '' })
  const q = r.remoteQueue()
  assert.equal(q.entries[0].status, 'published', out)
  assert.ok(q.entries[0].permalink.includes('instagram.com'))
  assert.equal(q.entries[0].tiktok.status, 'ready')
  assert.equal(r.remoteHat('reel-a.mp4'), false, 'Instagram raeumt seine Dateien wie bisher ab')
  assert.ok(out.includes('ZERNIO_API_KEY fehlt'))
  assert.equal(s.calls.filter((c) => c.p.startsWith('/z/')).length, 0)
}

szenarien['nachschuss-nr1-im-fenster'] = async ({ s }) => {
  s.konten = [{ _id: 'acc1', platform: 'tiktok', username: 'glanwick', isActive: true }]
  const r = repoMit({ entries: [
    igEintrag(s.port, 'ig-2', 'zwei', { tiktok: tt(s.port, 'zwei', { nr: 2 }) }),
    igEintrag(s.port, 'ig-1', 'eins', { tiktok: tt(s.port, 'eins', { nr: 1 }) }),
    igEintrag(s.port, 'ig-neu', 'neu', { tiktok: tt(s.port, 'neu') }),
  ] })
  const z = nyJetzt()
  const fix = { TIKTOK_ZEITEN_ZWEI: z, TIKTOK_ZEITEN_EINER: z }
  const { out } = await laufe(r.w, s.port, { sekunden: 20, env: fix })
  const q = r.remoteQueue()
  const [zwei, eins, neu] = q.entries
  assert.equal(eins.tiktok.status, 'published', out)
  assert.equal(eins.tiktok.url, 'https://www.tiktok.com/@glanwick/video/' + eins.tiktok.post_id)
  assert.ok(eins.tiktok.slot, 'Fenster belegt')
  assert.equal(zwei.tiktok.status, 'ready', 'nur einer je Fenster')
  assert.equal(neu.tiktok.status, 'ready')
  const posts = s.calls.filter((c) => c.p === '/z/v1/posts' && c.m === 'POST')
  assert.equal(posts.length, 1)
  const b = posts[0].body
  assert.equal(posts[0].h.idem, 'glanwick-tt-ig-1-1')
  assert.equal(b.publishNow, true)
  assert.equal(b.content, eins.caption)
  assert.deepEqual(b.platforms, [{ platform: 'tiktok', accountId: 'acc1' }])
  assert.equal(b.mediaItems[0].type, 'video')
  assert.ok(b.mediaItems[0].url.startsWith('https://cdn.zernio.test/'))
  const ts = b.tiktokSettings
  assert.equal(ts.privacy_level, 'PUBLIC_TO_EVERYONE')
  assert.equal(ts.video_made_with_ai, true)
  assert.equal(ts.content_preview_confirmed, true)
  assert.equal(ts.express_consent_given, true)
  assert.equal(ts.allow_comment && ts.allow_duet && ts.allow_stitch, true)
  assert.equal(ts.commercialContentType, 'none')
  assert.ok(ts.video_cover_image_url.startsWith('https://cdn.zernio.test/'))
  assert.deepEqual(s.uploads.map((u) => u.ct).sort(), ['image/jpeg', 'video/mp4'])
  assert.equal(s.uploads.find((u) => u.ct === 'video/mp4').len, 600_000)
  assert.ok(s.telegram.some((t) => t.includes('TikTok live') && t.includes('eins')))
  assert.ok(!out.includes(KEY) && !out.includes('GEHEIM') && !out.includes('/upload/'), 'Log verraet nichts')
  // Zweiter Lauf direkt danach: Abstand und belegtes Fenster verhindern einen zweiten Post
  await laufe(r.w, s.port, { sekunden: 8, env: fix })
  assert.equal(s.calls.filter((c) => c.p === '/z/v1/posts' && c.m === 'POST').length, 1)
  // Ohne Abstand bleibt das Fenster trotzdem belegt
  await laufe(r.w, s.port, { sekunden: 8, env: { ...fix, TIKTOK_ABSTAND_MIN: '0' } })
  assert.equal(s.calls.filter((c) => c.p === '/z/v1/posts' && c.m === 'POST').length, 1)
}

szenarien['ausserhalb-des-fensters-nichts'] = async ({ s }) => {
  s.konten = [{ _id: 'acc1', platform: 'tiktok', username: 'glanwick', isActive: true }]
  const r = repoMit({ entries: [igEintrag(s.port, 'ig-1', 'eins', { tiktok: tt(s.port, 'eins', { nr: 1 }) })] })
  const zu = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(new Date(Date.now() + 3 * 3600_000))
  await laufe(r.w, s.port, { sekunden: 8, env: { TIKTOK_ZEITEN_ZWEI: zu, TIKTOK_ZEITEN_EINER: zu } })
  assert.equal(r.remoteQueue().entries[0].tiktok.status, 'ready')
  assert.equal(s.calls.filter((c) => c.p === '/z/v1/posts').length, 0)
}

szenarien['angenommen-dann-nachgefragt'] = async ({ s }) => {
  s.konten = [{ _id: 'acc1', platform: 'tiktok', username: 'glanwick', isActive: true }]
  s.verhalten = 'pending'
  const r = repoMit({ entries: [igEintrag(s.port, 'ig-1', 'eins', { tiktok: tt(s.port, 'eins', { nr: 1 }) })] })
  const { out } = await laufe(r.w, s.port, { sekunden: 15 })
  const t = r.remoteQueue().entries[0].tiktok
  assert.equal(t.status, 'published', out)
  assert.ok(t.url.includes('/video/'))
  assert.ok(out.includes('angenommen'))
}

szenarien['fester-fehler-400'] = async ({ s }) => {
  s.konten = [{ _id: 'acc1', platform: 'tiktok', username: 'glanwick', isActive: true }]
  s.verhalten = '400'
  const r = repoMit({ entries: [igEintrag(s.port, 'ig-1', 'eins', { tiktok: tt(s.port, 'eins', { nr: 1 }) })] })
  await laufe(r.w, s.port, { sekunden: 8 })
  const t = r.remoteQueue().entries[0].tiktok
  assert.equal(t.status, 'error')
  assert.ok(t.fehler.includes('verbotene'))
  assert.equal(t.slot, undefined, 'Fenster wieder frei')
  assert.ok(s.telegram.some((x) => x.includes('TikTok-Fehler')))
}

szenarien['abgelehnt-207'] = async ({ s }) => {
  s.konten = [{ _id: 'acc1', platform: 'tiktok', username: 'glanwick', isActive: true }]
  s.verhalten = '207-failed'
  const r = repoMit({ entries: [igEintrag(s.port, 'ig-1', 'eins', { tiktok: tt(s.port, 'eins', { nr: 1 }) })] })
  await laufe(r.w, s.port, { sekunden: 8 })
  const t = r.remoteQueue().entries[0].tiktok
  assert.equal(t.status, 'error')
  assert.ok(t.fehler.includes('Spam'))
}

szenarien['voruebergehend-500-gleicher-schluessel'] = async ({ s }) => {
  s.konten = [{ _id: 'acc1', platform: 'tiktok', username: 'glanwick', isActive: true }]
  s.verhalten = '500'
  const r = repoMit({ entries: [igEintrag(s.port, 'ig-1', 'eins', { tiktok: tt(s.port, 'eins', { nr: 1 }) })] })
  await laufe(r.w, s.port, { sekunden: 8 })
  let t = r.remoteQueue().entries[0].tiktok
  assert.equal(t.status, 'ready')
  assert.equal(t.fehlversuche, 1)
  assert.equal(t.slot, undefined)
  // Nach dem Abstand neuer Versuch mit demselben Schluessel
  s.verhalten = 'published'
  await laufe(r.w, s.port, { sekunden: 8, env: { TIKTOK_ABSTAND_MIN: '0' } })
  t = r.remoteQueue().entries[0].tiktok
  assert.equal(t.status, 'published')
  const keys = s.calls.filter((c) => c.p === '/z/v1/posts').map((c) => c.h.idem)
  assert.deepEqual([...new Set(keys)], ['glanwick-tt-ig-1-1'])
}

szenarien['haengengeblieben-kein-doppelpost'] = async ({ s }) => {
  s.konten = [{ _id: 'acc1', platform: 'tiktok', username: 'glanwick', isActive: true }]
  // Erster Aufruf ging bei Zernio durch, der Waechter starb vor dem Eintragen
  s.posts.set('p900', { _id: 'p900', status: 'published', platforms: [{ platform: 'tiktok', status: 'published', platformPostUrl: 'https://www.tiktok.com/@glanwick/video/p900', platformPostId: 'p900' }] })
  s.idem.set('glanwick-tt-ig-1-1', 'p900')
  const r = repoMit({ entries: [igEintrag(s.port, 'ig-1', 'eins', { tiktok: tt(s.port, 'eins', { nr: 1, status: 'posting', gestartet_at: vor(30), versuch: 1 }) })] })
  const { out } = await laufe(r.w, s.port, { sekunden: 10, env: { TIKTOK_ABSTAND_MIN: '0' } })
  const t = r.remoteQueue().entries[0].tiktok
  assert.equal(t.status, 'published', out)
  assert.equal(t.post_id, 'p900', 'derselbe Beitrag, kein zweiter')
  assert.equal(s.posts.size, 1)
}

szenarien['gleichtakt-direkt-nach-instagram'] = async ({ s }) => {
  s.konten = [{ _id: 'acc1', platform: 'tiktok', username: 'glanwick', isActive: true }]
  const top = Array.from({ length: 12 }, (_, i) => igEintrag(s.port, `t${i + 1}`, `t${i + 1}`, { tiktok: { status: 'published', nr: i + 1, published_at: vor(600), gestartet_at: vor(600) } }))
  const r = repoMit({ entries: [
    ...top,
    { ...igEintrag(s.port, 'ig-neu', 'neu'), status: 'ready', published_at: undefined, scheduled_at: vor(1), tiktok: tt(s.port, 'neu') },
  ] }, ['neu.mp4', 'neu-cover.jpg'])
  // Zeiten weit weg, damit nur der Gleichtakt posten kann
  const zu = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(new Date(Date.now() + 5 * 3600_000))
  const { out } = await laufe(r.w, s.port, { sekunden: 25, env: { TIKTOK_ZEITEN_ZWEI: zu, TIKTOK_ZEITEN_EINER: zu } })
  const e = r.remoteQueue().entries.at(-1)
  assert.equal(e.status, 'published', out)
  assert.equal(e.tiktok.status, 'published', out)
  assert.equal(e.tiktok.slot, undefined, 'Gleichtakt belegt kein Nachschuss-Fenster')
  const igZeit = s.calls.findIndex((c) => c.p === '/ig/me/media_publish')
  const ttZeit = s.calls.findIndex((c) => c.p === '/z/v1/posts')
  assert.ok(igZeit >= 0 && ttZeit > igZeit, 'TikTok erst nach Instagram')
  assert.equal(r.remoteHat('neu.mp4'), false, 'Instagram raeumt ab, TikTok nutzt den Release')
}

szenarien['doppelter-slug-wird-uebersprungen'] = async ({ s }) => {
  s.konten = [{ _id: 'acc1', platform: 'tiktok', username: 'glanwick', isActive: true }]
  const r = repoMit({ entries: [
    igEintrag(s.port, 'ig-alt', 'gleich', { tiktok: { status: 'published', nr: 5, published_at: vor(900), gestartet_at: vor(900) } }),
    igEintrag(s.port, 'ig-neu', 'gleich', { tiktok: tt(s.port, 'gleich', { nr: 1 }) }),
  ] })
  await laufe(r.w, s.port, { sekunden: 8 })
  const q = r.remoteQueue()
  assert.equal(q.entries[1].tiktok.status, 'uebersprungen')
  assert.equal(s.calls.filter((c) => c.p === '/z/v1/posts').length, 0)
}

szenarien['konto-getrennt-pausiert'] = async ({ s }) => {
  s.konten = [{ _id: 'acc1', platform: 'tiktok', username: 'glanwick', isActive: true, needsReconnection: true }]
  const r = repoMit({ entries: [igEintrag(s.port, 'ig-1', 'eins', { tiktok: tt(s.port, 'eins', { nr: 1 }) })] })
  const { out } = await laufe(r.w, s.port, { sekunden: 8 })
  assert.equal(r.remoteQueue().entries[0].tiktok.status, 'ready')
  assert.equal(s.telegram.filter((t) => t.includes('TikTok pausiert')).length, 1, out)
  assert.equal(s.calls.filter((c) => c.p === '/z/v1/posts').length, 0)
}

szenarien['kein-konto-still'] = async ({ s }) => {
  s.konten = []
  const r = repoMit({ entries: [igEintrag(s.port, 'ig-1', 'eins', { tiktok: tt(s.port, 'eins', { nr: 1 }) })] })
  const { out } = await laufe(r.w, s.port, { sekunden: 8 })
  assert.equal(r.remoteQueue().entries[0].tiktok.status, 'ready')
  assert.deepEqual(s.telegram.filter((t) => /tiktok/i.test(t)), [], 'keine TikTok-Nachricht, solange nur das Konto fehlt: ' + JSON.stringify(s.telegram))
  assert.ok(out.includes('noch kein TikTok-Konto'))
  assert.equal(s.calls.filter((c) => c.p === '/z/v1/accounts').length, 1, 'nicht jede Sekunde nachfragen')
}

szenarien['fehlende-datei-fester-fehler'] = async ({ s }) => {
  s.konten = [{ _id: 'acc1', platform: 'tiktok', username: 'glanwick', isActive: true }]
  const r = repoMit({ entries: [
    igEintrag(s.port, 'ig-1', 'eins', { tiktok: tt(s.port, 'eins', { nr: 1, video_url: F(s.port, 'fehlt.mp4') }) }),
    igEintrag(s.port, 'ig-2', 'zwei', { tiktok: tt(s.port, 'zwei', { nr: 2 }) }),
  ] })
  await laufe(r.w, s.port, { sekunden: 8, env: { TIKTOK_ABSTAND_MIN: '0' } })
  const [a, b] = r.remoteQueue().entries
  assert.equal(a.tiktok.status, 'error')
  assert.ok(a.tiktok.fehler.includes('404'))
  assert.equal(b.tiktok.status, 'published', 'der naechste nutzt das freie Fenster')
}

// ---------------------------------------------------------------- Ablauf
const namen = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(szenarien)
let gut = 0
for (const n of namen) {
  const { s, server } = await starteMock()
  const t0 = Date.now()
  try {
    await szenarien[n]({ s })
    gut++
    console.log(`BESTANDEN ${n} (${Math.round((Date.now() - t0) / 1000)} s)`)
  } catch (e) {
    console.log(`FEHLER    ${n}: ${e.message.split('\n').slice(0, 12).join('\n')}`)
  } finally {
    server.close()
  }
}
console.log(`\n${gut}/${namen.length} Szenarien bestanden`)
process.exit(gut === namen.length ? 0 : 1)
