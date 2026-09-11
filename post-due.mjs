#!/usr/bin/env node
// Dauerwaechter: postet faellige Eintraege aus queue.json auf @glanwick_com.
//
// WARUM DIESES SKRIPT IN DIESEM REPO LIEGT
// Der Poster lief bis 04.09.2026 im privaten Repo GlanWick/glanwick, geplant
// alle 15 Minuten. GitHub drosselt geplante Laeufe massiv: gemessen 4 bis 5
// statt 96 Laeufen pro Tag, groesster Abstand 4,5 Stunden. Ein Post ging
// dadurch bis zu 2,5 Stunden nach seinem Slot raus, manche Slots fielen aus.
//
// Der Ausweg ist ein Job, der WARTET statt staendig neu gestartet zu werden.
// Warten kostet Actions-Minuten, und die sind nur in oeffentlichen Repos frei.
// Dieses Repo ist oeffentlich, das private nicht. Deshalb liegt der Poster hier.
//
// Der Job laeuft bis zu 5 h 50 min und prueft alle 30 Sekunden. Solange GitHub
// die Zeitplanung mindestens alle 6 Stunden ausloest (gemessen: alle 2 bis 4,5
// Stunden), ist immer ein Waechter wach und ein Post geht innerhalb einer
// halben Minute nach seinem Slot raus.
//
// LOG-DISZIPLIN: Dieses Repo ist oeffentlich, also sind auch die Action-Logs
// oeffentlich. Es wird nie eine URL und nie der Token ausgegeben, nur Werte,
// die ohnehin oeffentlich sind (Queue-IDs, Permalinks, Statuscodes).

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const API = 'https://graph.instagram.com/v23.0'
const ROOT = dirname(fileURLToPath(import.meta.url))
const QUEUE_PATH = join(ROOT, 'queue.json')

const RUN_MS = Number(process.env.WATCH_MINUTES || 350) * 60_000
const TICK_MS = 30_000
const token = process.env.IG_TOKEN
if (!token) {
  console.error('IG_TOKEN fehlt.')
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ts = () => new Date().toISOString().slice(11, 19) + 'Z'
const log = (m) => console.log(`${ts()} ${m}`)

async function api(method, path, params) {
  const url = new URL(API + path)
  const body = new URLSearchParams()
  for (const [k, v] of Object.entries(params || {})) {
    if (method === 'GET') url.searchParams.set(k, v)
    else body.set(k, v)
  }
  url.searchParams.set('access_token', token)
  const res = await fetch(url, method === 'GET' ? {} : { method, body })
  const json = await res.json().catch(() => ({}))
  // Bewusst ohne URL und ohne Token im Fehlertext - die Logs sind oeffentlich.
  if (!res.ok || json.error) throw new Error(json?.error?.message || `HTTP ${res.status}`)
  return json
}

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()

// Der Waechter laeuft Stunden. In der Zeit koennen neue Eintraege dazukommen
// (Mirror-Push vom Rechner), deshalb vor jeder Pruefung frisch ziehen.
function pullQueue() {
  try {
    git('pull', '--rebase', '--quiet', 'origin', 'main')
  } catch {
    // Netz weg oder Konflikt: mit dem lokalen Stand weiterarbeiten.
  }
  return JSON.parse(readFileSync(QUEUE_PATH, 'utf8'))
}


// Alle Dateien im Repo, auf die ein Eintrag zeigt (Video, Cover, Bilder).
const assetFilesOf = (entry) => {
  const urls = [entry.video_url, entry.cover_url, entry.image_url, ...(entry.image_urls || [])].filter(Boolean)
  return urls.map((u) => u.split('/').pop()).filter((f) => /^[\w.-]+$/.test(f))
}


// Telegram-Nachricht an Jan, sobald ein Beitrag live ist: Die erste Stunde
// entscheidet (Sends und Antworten auf Kommentare sind die staerksten
// Signale). Ohne die beiden Secrets passiert still nichts.
async function notify(text) {
  const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID
  if (!tok || !chat) return
  try {
    await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text }),
    })
  } catch (e) { log(`Telegram fehlgeschlagen: ${e.message}`) }
}

function saveAndPush(queue, message) {
  writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2) + '\n')
  git('config', 'user.name', 'glanwick-social-bot')
  git('config', 'user.email', 'noreply@glanwick.com')
  git('add', '-A')
  git('commit', '-m', message)
  for (let i = 0; i < 3; i++) {
    try {
      git('push', 'origin', 'main')
      return
    } catch {
      try {
        git('pull', '--rebase', 'origin', 'main')
      } catch {
        // naechster Versuch
      }
    }
  }
  throw new Error('Queue-Push fehlgeschlagen')
}

// ---------------------------------------------------------------------------
// Beitragsarten. Ein Eintrag ohne "kind" ist ein Reel (Bestand, unveraendert).
//   reel      video_url
//   image     image_url                (Feed-Bild, 4:5 bis 1.91:1, JPEG!)
//   carousel  image_urls[]             (2 bis 10 JPEGs, alle im selben Format)
//   story     image_url oder video_url (9:16; ohne Sticker - die API kann
//             keine Umfragen, Quiz oder Frage-Sticker setzen)
// Instagram nimmt fuer Bilder nur JPEG an. PNG vorher umwandeln.
// Alle Arten tragen die KI-Kennzeichnung, weil alles hier KI-erzeugt ist.
// ---------------------------------------------------------------------------
async function createContainer(entry) {
  const kind = entry.kind || 'reel'
  const ai = { is_ai_generated: 'true' }
  if (kind === 'reel') {
    // cover_url: eigenes Vorschaubild (JPEG) fuer das Profil-Raster. Ohne
    // Angabe nimmt Instagram ein Standbild aus dem Video.
    const cover = entry.cover_url ? { cover_url: entry.cover_url } : {}
    return api('POST', '/me/media', {
      media_type: 'REELS', video_url: entry.video_url, caption: entry.caption,
      share_to_feed: 'true', ...cover, ...ai,
    })
  }
  if (kind === 'image') {
    return api('POST', '/me/media', { image_url: entry.image_url, caption: entry.caption, ...ai })
  }
  if (kind === 'carousel') {
    const urls = entry.image_urls || []
    if (urls.length < 2 || urls.length > 10) throw new Error(`Karussell braucht 2 bis 10 Bilder, hat ${urls.length}`)
    // Das KI-Label darf NUR auf dem Karussell-Container stehen. Auf den
    // einzelnen Bildern lehnt Instagram es ab (Fehler 2207100, 06.09.2026).
    const children = []
    for (const u of urls) {
      const c = await api('POST', '/me/media', { image_url: u, is_carousel_item: 'true' })
      children.push(c.id)
    }
    return api('POST', '/me/media', {
      media_type: 'CAROUSEL', children: children.join(','), caption: entry.caption, ...ai,
    })
  }
  if (kind === 'story') {
    const p = entry.video_url ? { video_url: entry.video_url } : { image_url: entry.image_url }
    return api('POST', '/me/media', { media_type: 'STORIES', ...p, ...ai })
  }
  throw new Error(`Unbekannte Beitragsart: ${kind}`)
}

async function postEntry(entry, queue) {
  const limit = await api('GET', '/me/content_publishing_limit', {})
  const used = limit?.data?.[0]?.quota_usage ?? 0
  if (used >= 50) {
    log(`Publishing-Limit ${used}/50 erreicht, ${entry.id} bleibt liegen.`)
    return false
  }

  log(`POST ${entry.id}`)
  // Der Eintrag wird SOFORT auf "posting" gesetzt und gepusht. Damit sieht ein
  // parallel gestarteter Waechter ihn nicht mehr als faellig an - das ist der
  // Doppelpost-Schutz zwischen zwei ueberlappenden Laeufen.
  entry.status = 'posting'
  entry.posting_started_at = new Date().toISOString()
  saveAndPush(queue, `[skip ci] Queue: ${entry.id} wird gepostet`)

  try {
    const container = await createContainer(entry)
    entry.container_id = container.id

    let status = ''
    for (let i = 0; i < 60; i++) {
      await sleep(10_000)
      const s = await api('GET', `/${container.id}`, { fields: 'status_code' })
      status = s.status_code
      if (status === 'FINISHED' || status === 'ERROR') break
    }
    if (status !== 'FINISHED') throw new Error(`Container-Status ${status || 'TIMEOUT'}`)

    const published = await api('POST', '/me/media_publish', { creation_id: container.id })
    const media = await api('GET', `/${published.id}`, { fields: 'permalink' })
    entry.status = 'published'
    entry.media_id = published.id
    entry.permalink = media.permalink
    entry.published_at = new Date().toISOString()
    delete entry.error
    delete entry.posting_started_at
    // Instagram hat jetzt eine eigene Kopie. Die Dateien bleiben nur in der
    // Historie, nicht im Arbeitsstand: GitHub Pages veroeffentlicht bis 1 GB,
    // und 35 Reels haben das am 09.09.2026 gerissen (Builds fehlgeschlagen,
    // 404 statt Video, Container-ERROR).
    for (const f of assetFilesOf(entry)) {
      if (existsSync(join(ROOT, f))) { unlinkSync(join(ROOT, f)); log(`Asset entfernt: ${f}`) }
    }
    saveAndPush(queue, `[skip ci] Queue: ${entry.id} veroeffentlicht, Assets entfernt`)
    log(`VEROEFFENTLICHT ${entry.id} ${media.permalink}`)
    const berlin = new Date().toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' })
    await notify(`Live um ${berlin} Berlin: ${entry.slug}\n${media.permalink}\n\nJetzt: in die Story teilen, an 3 Trader senden, Kommentare beantworten.`)
    return true
  } catch (e) {
    entry.status = 'error'
    entry.error = `${e instanceof Error ? e.message : String(e)} (${new Date().toISOString()})`
    delete entry.posting_started_at
    saveAndPush(queue, `[skip ci] Queue: ${entry.id} fehlgeschlagen`)
    log(`FEHLER ${entry.id}: ${entry.error}`)
    return false
  }
}

// ---------------------------------------------------------------------------
// Kennzahlen fuer das Admin-Dashboard: stats.json, stuendlich.
//
// Es landen NUR Werte darin, die auf dem Instagram-Profil ohnehin oeffentlich
// sind: Followerzahl, Beitragszahl, je Beitrag Aufrufe, Likes, Kommentare.
// Reichweite, Sehdauer, Speicherungen und Weiterleitungen sind private
// Insights und bleiben bewusst draussen, weil diese Datei oeffentlich ist.
// ---------------------------------------------------------------------------
const STATS_PATH = join(ROOT, 'stats.json')
const STATS_EVERY_MS = 60 * 60_000
let lastStatsAt = 0


// ---------------------------------------------------------------------------
// Fruehwarnung (seit 11.09.2026). Zwischen 07.09. und 10.09. fiel die
// Tagesreichweite von 6.221 auf 226, und niemand hat es gesehen, weil nur die
// Followerzahl beobachtet wurde. Zwei Signale, stuendlich geprueft:
//   1. Tagesreichweite gestern unter 40 % des Mittels der sechs Tage davor.
//   2. Die letzten drei Reels halten im Mittel unter 8 Sekunden.
// Jede Aenderung des Zustands geht per Telegram raus; der Zustand steht in
// stats.json (nur Aggregate, keine privaten Kennzahlen je Beitrag).
// ---------------------------------------------------------------------------
async function guardrail(posts, prevGuard) {
  const day = 86_400_000
  const until = new Date(); until.setUTCHours(0, 0, 0, 0)
  const since = new Date(until.getTime() - 7 * day)
  let reachDays = []
  try {
    const r = await api('GET', '/me/insights', {
      metric: 'reach', period: 'day',
      since: since.toISOString().slice(0, 10), until: until.toISOString().slice(0, 10),
    })
    reachDays = (r?.data?.[0]?.values || []).map((v) => ({ day: v.end_time.slice(0, 10), reach: v.value }))
  } catch (e) { log(`Fruehwarnung: Reichweite nicht lesbar (${e.message})`) }
  const reels = posts.filter((p) => p.type === 'VIDEO').slice(0, 3)
  const watch = []
  for (const p of reels) {
    try {
      const ins = await api('GET', `/${p.id}/insights`, { metric: 'ig_reels_avg_watch_time' })
      const ms = ins?.data?.[0]?.values?.[0]?.value
      if (typeof ms === 'number') watch.push(ms / 1000)
    } catch { /* zu jung oder kein Reel */ }
  }
  const reasons = []
  if (reachDays.length >= 4) {
    const last = reachDays[reachDays.length - 1]
    const before = reachDays.slice(0, -1).map((d) => d.reach)
    const avg = before.reduce((a, b) => a + b, 0) / before.length
    if (avg > 0 && last.reach < 0.4 * avg) reasons.push(`Reichweite ${last.day}: ${last.reach} gegen Mittel ${Math.round(avg)}`)
  }
  const avgWatch = watch.length ? watch.reduce((a, b) => a + b, 0) / watch.length : null
  if (avgWatch !== null && watch.length >= 2 && avgWatch < 8) reasons.push(`Sehdauer letzte ${watch.length} Reels: ${avgWatch.toFixed(1)} s`)
  const status = reasons.length ? 'warn' : 'ok'
  const guard = {
    status, reasons, checked: new Date().toISOString(),
    reach_days: reachDays, avg_watch_last_reels: avgWatch === null ? null : +avgWatch.toFixed(1),
  }
  if (prevGuard?.status !== status) {
    await notify(status === 'warn'
      ? `FRUEHWARNUNG Instagram:\n${reasons.join('\n')}\n\nRegel: nur 2 Reels/Tag, nur erprobte Familien, kein Experiment, bis die Reichweite drei Tage steigt.`
      : 'Instagram: Fruehwarnung aufgehoben, Reichweite und Sehdauer wieder im Rahmen.')
    log(`Fruehwarnung: ${status} ${reasons.join('; ')}`)
  }
  return guard
}

async function writeStats(queue) {
  const me = await api('GET', '/me', { fields: 'username,followers_count,media_count' })
  const media = await api('GET', '/me/media', {
    fields: 'id,caption,permalink,timestamp,media_type,like_count,comments_count',
    limit: '40',
  })
  const slugByMedia = Object.fromEntries(
    queue.entries.filter((e) => e.media_id).map((e) => [e.media_id, e.slug]),
  )
  const posts = []
  for (const m of media.data || []) {
    let views = null
    try {
      const ins = await api('GET', `/${m.id}/insights`, { metric: 'views' })
      views = ins?.data?.[0]?.values?.[0]?.value ?? null
    } catch {
      // Aeltere Feed-Beitraege liefern die Kennzahl nicht; dann bleibt sie leer.
    }
    posts.push({
      id: m.id,
      slug: slugByMedia[m.id] ?? null,
      permalink: m.permalink,
      timestamp: m.timestamp,
      type: m.media_type,
      caption: (m.caption || '').split('\n')[0].slice(0, 80),
      views,
      likes: m.like_count ?? null,
      comments: m.comments_count ?? null,
    })
  }

  let prev = { history: [] }
  try { prev = JSON.parse(readFileSync(STATS_PATH, 'utf8')) } catch { /* erste Datei */ }
  const ts = new Date().toISOString()
  const history = [...(prev.history || []), {
    ts, followers: me.followers_count, media_count: me.media_count,
  }].slice(-4000)

  const guard = await guardrail(posts, prev.guardrail)
  const out = {
    updated: ts,
    guardrail: guard,
    source: 'Waechter, stuendlich; nur oeffentlich sichtbare Kennzahlen',
    account: { username: me.username, followers: me.followers_count, media_count: me.media_count },
    history,
    posts,
  }
  writeFileSync(STATS_PATH, JSON.stringify(out, null, 1) + '\n')
  git('config', 'user.name', 'glanwick-social-bot')
  git('config', 'user.email', 'noreply@glanwick.com')
  git('add', 'stats.json')
  try {
    git('commit', '-m', `[skip ci] Stats ${ts.slice(11, 16)}Z: ${me.followers_count} Follower`)
    for (let i = 0; i < 3; i++) {
      try { git('push', 'origin', 'main'); break } catch {
        try { git('pull', '--rebase', 'origin', 'main') } catch { /* naechster Versuch */ }
      }
    }
  } catch {
    // nichts geaendert oder Push fehlgeschlagen - beim naechsten Takt erneut
  }
  log(`Stats geschrieben: ${me.followers_count} Follower, ${posts.length} Beitraege`)
}

const started = Date.now()
log(`Waechter gestartet, laeuft bis zu ${Math.round(RUN_MS / 60000)} Minuten.`)

while (Date.now() - started < RUN_MS) {
  let queue
  try {
    queue = pullQueue()
  } catch (e) {
    log(`Queue nicht lesbar: ${e.message}`)
    await sleep(TICK_MS)
    continue
  }

  if (Date.now() - lastStatsAt > STATS_EVERY_MS) {
    lastStatsAt = Date.now()
    try { await writeStats(queue) } catch (e) { log(`Stats fehlgeschlagen: ${e.message}`) }
  }

  const now = new Date()

  // Haengengebliebenes "posting" nach 20 Minuten freigeben: dann ist der
  // Waechter, der es gesetzt hat, sicher tot (das Job-Limit greift vorher).
  for (const e of queue.entries) {
    if (
      e.status === 'posting' &&
      e.posting_started_at &&
      now - new Date(e.posting_started_at) > 20 * 60_000
    ) {
      e.status = 'ready'
      delete e.posting_started_at
      saveAndPush(queue, `[skip ci] Queue: ${e.id} zurueck auf ready (haengengeblieben)`)
      log(`${e.id} war haengengeblieben, wieder auf ready.`)
    }
  }

  const due = queue.entries
    .filter((e) => e.status === 'ready' && new Date(e.scheduled_at) <= now)
    .sort((a, b) => Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at))

  if (due.length) await postEntry(due[0], queue)
  else await sleep(TICK_MS)
}

log('Waechter beendet, der naechste Lauf uebernimmt.')
