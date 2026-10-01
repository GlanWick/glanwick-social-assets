#!/usr/bin/env node
// Dauerwaechter: postet faellige Eintraege aus queue.json auf @glanwick_com.
// Seit 26.09.2026 auch auf TikTok, ueber tiktok.mjs (Eintraege mit Block
// "tiktok", immer erst nach dem Instagram-Post). Der Instagram-Teil hier ist
// davon unberuehrt; faellt TikTok aus, laeuft Instagram weiter.
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
import { erstelleTikTok } from './tiktok.mjs'

// Die *_API_BASE- und TICK_MS-Variablen gibt es nur fuer den Probelauf gegen
// einen nachgebauten Server; im Workflow sind sie nicht gesetzt.
const API = process.env.IG_API_BASE || 'https://graph.instagram.com/v23.0'
const TELEGRAM = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org'
const ROOT = dirname(fileURLToPath(import.meta.url))
const QUEUE_PATH = join(ROOT, 'queue.json')

const RUN_MS = Number(process.env.WATCH_MINUTES || 350) * 60_000
const TICK_MS = Number(process.env.TICK_MS || 30_000)
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
    await fetch(`${TELEGRAM}/bot${tok}/sendMessage`, {
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
// ---------------------------------------------------------------------------
// Testreels (seit 30.09.2026): "trial": "SS_PERFORMANCE" zeigt das Reel zuerst
// nur Nicht-Followern und gibt es bei guten Zahlen selbst an die Follower
// weiter; "MANUAL" bleibt Testreel, bis Jan es in der App freigibt.
//
// Die Gefahr ist ein Testreel, das still als normales Reel im Profil landet.
// Deshalb gilt hier "im Zweifel nicht posten":
//   - Ein Feld "trial" mit unbekanntem Wert ist ein Fehler, nie ein normales Reel.
//   - Normale Beitraege gehen immer vor; ein wartendes Testreel blockiert nichts.
//   - Hoechstens eins pro Stunde und 14 je 24 Stunden (Plan 12, Instagram 20).
//   - Nach jedem Testreel liest der Waechter nach: Beitragszahl des Kontos vor
//     und nach dem Post (ein Testreel zaehlt nicht mit) und is_shared_to_feed.
//     Sieht eins nach normalem Reel aus, halten ALLE weiteren Testreels an, bis
//     jemand das geprueft hat (Freigabe: "trial_pruefung_ok": true am Eintrag).
// ---------------------------------------------------------------------------
const TESTREEL_ARTEN = ['MANUAL', 'SS_PERFORMANCE']
const TESTREEL_ABSTAND_MS = 60 * 60_000
const TESTREEL_JE_24H = 14
const TESTREEL_PRUEF_WARTEN_MS = Number(process.env.TESTREEL_PRUEF_WARTEN_MS || 60_000)

const istTestreel = (entry) => entry.trial !== undefined && entry.trial !== null && entry.trial !== false

function testreelFehler(entry) {
  if (!istTestreel(entry)) return null
  if ((entry.kind || 'reel') !== 'reel') return `Testreel geht nur als Reel, nicht als ${entry.kind}`
  if (!TESTREEL_ARTEN.includes(entry.trial)) return `Unbekannter Testreel-Wert ${JSON.stringify(entry.trial)}`
  return null
}

// Grund, warum ein faelliges Testreel jetzt noch nicht rausgeht, sonst null.
function testreelWartet(entry, queue, now) {
  if (!istTestreel(entry)) return null
  const verdacht = queue.entries.find((e) => e.trial_pruefung?.verdacht && e.trial_pruefung_ok !== true)
  if (verdacht) return `angehalten, Verdacht bei ${verdacht.id} ungeprueft`
  const zeiten = queue.entries
    .filter((e) => istTestreel(e) && e !== entry)
    .map((e) => Date.parse(e.published_at || e.posting_started_at || ''))
    .filter((t) => Number.isFinite(t))
  const imTag = zeiten.filter((t) => now - t < 24 * 3600_000).length
  if (imTag >= TESTREEL_JE_24H) return `${imTag} Testreels in 24 Stunden`
  const letztes = zeiten.length ? Math.max(...zeiten) : 0
  if (now - letztes < TESTREEL_ABSTAND_MS) return `letztes Testreel vor ${Math.round((now - letztes) / 60_000)} Minuten`
  return null
}

// Nach dem Posten: Sieht das Testreel wie ein normales Reel aus? Ergebnis steht
// danach am Eintrag. Ein Lesefehler zaehlt als Verdacht (im Zweifel anhalten).
//
// Befund 01.10.2026 (erstes echtes Testreel, media_id 18123540976904919):
// Testreels STEHEN in /me/media, zaehlen aber NICHT in media_count (blieb 97)
// und tragen is_shared_to_feed = false. Das trennende Merkmal ist also die
// Beitragszahl: Steigt sie durch den Post, ist es ein normales Reel.
async function beitragszahl() {
  const me = await api('GET', '/me', { fields: 'media_count' })
  if (typeof me.media_count !== 'number') throw new Error('media_count fehlt')
  return me.media_count
}

async function testreelPruefen(entry, mediaId, vorher) {
  try {
    await sleep(TESTREEL_PRUEF_WARTEN_MS)
    const m = await api('GET', `/${mediaId}`, { fields: 'is_shared_to_feed,media_product_type' })
    const liste = await api('GET', '/me/media', { fields: 'id', limit: '25' })
    const nachher = await beitragszahl()
    const imProfil = (liste.data || []).some((x) => x.id === mediaId)
    entry.trial_pruefung = {
      beitraege_vorher: vorher,
      beitraege_nachher: nachher,
      in_me_media: imProfil,
      is_shared_to_feed: m.is_shared_to_feed ?? null,
      media_product_type: m.media_product_type ?? null,
      verdacht: typeof vorher !== 'number' || nachher > vorher || m.is_shared_to_feed === true,
      at: new Date().toISOString(),
    }
  } catch (e) {
    entry.trial_pruefung = { fehler: e instanceof Error ? e.message : String(e), verdacht: true, at: new Date().toISOString() }
  }
  return entry.trial_pruefung
}

async function createContainer(entry) {
  const kind = entry.kind || 'reel'
  const ai = { is_ai_generated: 'true' }
  const trialFehler = testreelFehler(entry)
  if (trialFehler) throw new Error(trialFehler)
  if (kind === 'reel') {
    // cover_url: eigenes Vorschaubild (JPEG) fuer das Profil-Raster. Ohne
    // Angabe nimmt Instagram ein Standbild aus dem Video.
    const cover = entry.cover_url ? { cover_url: entry.cover_url } : {}
    // Testreels ohne share_to_feed: genau die Kombination, die Instagram am
    // 30.09.2026 als Entwurf angenommen hat (Container FINISHED).
    const ziel = istTestreel(entry)
      ? { trial_params: JSON.stringify({ graduation_strategy: entry.trial }) }
      : { share_to_feed: 'true' }
    return api('POST', '/me/media', {
      media_type: 'REELS', video_url: entry.video_url, caption: entry.caption,
      ...ziel, ...cover, ...ai,
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

// ---------------------------------------------------------------------------
// Eigener Kommentar direkt nach dem Posten (seit 29.09.2026, Jans Freigabe):
// der Weg vom Video zum Produkt. Links sind in Instagram-Kommentaren nicht
// klickbar, deshalb die kurze Adresse, die auch im Profil verlinkt ist.
//   kein Feld "kommentar"   Reels bekommen STANDARD_KOMMENTAR, andere Arten nichts
//   "kommentar": "Text"     genau dieser Text (auch fuer Bild und Karussell)
//   "kommentar": false      kein Kommentar
// Stories koennen keine Kommentare tragen. Ein Fehler hier aendert nie den
// Status "published": Er wird als kommentar_fehler vermerkt und per Telegram
// gemeldet. Braucht die Berechtigung instagram_business_manage_comments.
// ---------------------------------------------------------------------------
const STANDARD_KOMMENTAR =
  'Track your real win rate and equity curve from your own trades. Free journal: glanwick.com/ig'

function kommentarText(entry) {
  const kind = entry.kind || 'reel'
  if (kind === 'story' || entry.kommentar === false || entry.kommentar === '') return null
  if (typeof entry.kommentar === 'string') return entry.kommentar
  return kind === 'reel' ? STANDARD_KOMMENTAR : null
}

async function kommentieren(entry, mediaId, queue) {
  const text = kommentarText(entry)
  if (!text) return 'Kein Link-Kommentar vorgesehen.'
  try {
    const c = await api('POST', `/${mediaId}/comments`, { message: text })
    entry.kommentar_id = c.id
    delete entry.kommentar_fehler
    log(`Kommentar gesetzt: ${entry.id}`)
    try { saveAndPush(queue, `[skip ci] Queue: ${entry.id} Kommentar gesetzt`) } catch (e) { log(`Kommentar-Vermerk nicht gepusht: ${e.message}`) }
    return 'Link-Kommentar gesetzt.'
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    entry.kommentar_fehler = `${msg} (${new Date().toISOString()})`
    log(`Kommentar fehlgeschlagen ${entry.id}: ${msg}`)
    try { saveAndPush(queue, `[skip ci] Queue: ${entry.id} Kommentar fehlgeschlagen`) } catch { /* Vermerk geht mit dem naechsten Push */ }
    return `Link-Kommentar FEHLGESCHLAGEN: ${msg}`
  }
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
    // Testreels: Beitragszahl vorher festhalten (Vergleich nach dem Posten).
    const beitraegeVorher = istTestreel(entry) ? await beitragszahl().catch(() => null) : null
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
    // Ab hier ist der Beitrag live. Ein Lesefehler beim Permalink darf ihn nie
    // auf "error" setzen (sonst postet der naechste Takt ihn ein zweites Mal).
    const media = await api('GET', `/${published.id}`, { fields: 'permalink' }).catch(() => ({}))
    entry.status = 'published'
    entry.media_id = published.id
    entry.permalink = media.permalink || null
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
    log(`VEROEFFENTLICHT ${entry.id} ${entry.permalink}`)
    // Testreel-Pruefung erst NACH dem gesicherten "published" (ein Absturz
    // dazwischen darf nie zu einem zweiten Post fuehren), dann eigener Vermerk.
    let pruefung = null
    if (istTestreel(entry)) {
      pruefung = await testreelPruefen(entry, published.id, beitraegeVorher)
      log(`Testreel geprueft ${entry.id}: ${JSON.stringify(pruefung)}`)
      try { saveAndPush(queue, `[skip ci] Queue: ${entry.id} Testreel geprueft${pruefung.verdacht ? ' VERDACHT' : ''}`) } catch (e) { log(`Pruefvermerk nicht gepusht: ${e.message}`) }
    }
    // Erst NACH dem gesicherten "published" kommentieren: Nichts, was hier
    // schiefgeht, darf den Eintrag zurueck auf "error" oder "ready" setzen.
    const kommentar = await kommentieren(entry, published.id, queue)
    const berlin = new Date().toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' })
    if (pruefung) {
      const merkmale = pruefung.fehler
        ? `Pruefung nicht lesbar: ${pruefung.fehler}`
        : `Beitragszahl ${pruefung.beitraege_vorher} -> ${pruefung.beitraege_nachher}, is_shared_to_feed: ${pruefung.is_shared_to_feed}`
      await notify(pruefung.verdacht
        ? `TESTREEL-VERDACHT um ${berlin} Berlin: ${entry.slug} sieht nach normalem Reel aus.\n${entry.permalink}\n${merkmale}\n\nAlle weiteren Testreels sind angehalten. Bitte im Profil nachsehen, ob das Reel im Raster steht.`
        : `Testreel live um ${berlin} Berlin (nur Nicht-Follower): ${entry.slug}\n${entry.permalink}\n${merkmale}\n${kommentar}\n\nNicht teilen. Urteil nach 12 Stunden.`)
      return true
    }
    await notify(`Live um ${berlin} Berlin: ${entry.slug}\n${entry.permalink}\n${kommentar}\n\nJetzt: in die Story teilen, an 3 Trader senden, Kommentare beantworten.`)
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

  // Testreels laufen nur bei Nicht-Followern und sind oft Experimente; sie
  // wuerden die Sehdauer-Warnung fuer die normalen Reels verfaelschen.
  const testreelIds = new Set(queue.entries.filter((e) => istTestreel(e) && e.media_id).map((e) => e.media_id))
  const guard = await guardrail(posts.filter((p) => !testreelIds.has(p.id)), prev.guardrail)
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

// ---------------------------------------------------------------------------
// 12-Stunden-Stand (seit 30.09.2026): Die Aufrufe nach 12 Stunden sagen die
// Endzahl gut voraus (r = 0,93, gemessen am 29.09.). Danach werden Testreels
// beurteilt. Der Waechter haelt den Wert je Reel einmal fest, rund um die Uhr;
// Aufrufe zeigt Instagram ohnehin oeffentlich am Reel.
// ---------------------------------------------------------------------------
async function zwoelfStunden(queue) {
  // Testreels zeigen ihre Zahlen laut Instagram erst nach rund 24 Stunden (am
  // 01.10.2026 nach 11 Minuten noch 0 Aufrufe). Deshalb bei Testreels eine 0
  // nicht festschreiben und zusaetzlich den 24-Stunden-Stand halten.
  const jetzt = Date.now()
  let neu = 0
  for (const e of queue.entries) {
    if (e.status !== 'published' || !e.media_id || (e.kind || 'reel') !== 'reel') continue
    const alter = jetzt - Date.parse(e.published_at || '')
    const stufen = istTestreel(e) ? [['views_12h', 12], ['views_24h', 24]] : [['views_12h', 12]]
    for (const [feld, h] of stufen) {
      if (e[feld] || !(alter >= h * 3600_000 && alter < (h + 2) * 3600_000)) continue
      try {
        const ins = await api('GET', `/${e.media_id}/insights`, { metric: 'views' })
        const v = ins?.data?.[0]?.values?.[0]?.value
        if (typeof v === 'number' && (v > 0 || !istTestreel(e))) {
          e[feld] = { views: v, stunden: +(alter / 3600_000).toFixed(2) }
          neu++
        }
      } catch (err) { log(`${feld} ${e.id} nicht lesbar: ${err.message}`) }
    }
  }
  if (neu) saveAndPush(queue, `[skip ci] Queue: Aufrufe-Stand fuer ${neu} Reel(s)`)
}

const tiktokTakt = erstelleTikTok({ saveAndPush, notify, log })
// Wartende Testreels nur einmal je Grund ins (oeffentliche) Log schreiben.
const wartendGemeldet = new Map()

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
    try { await zwoelfStunden(queue) } catch (e) { log(`12-Stunden-Stand fehlgeschlagen: ${e.message}`) }
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

  // Normale Beitraege vor Testreels, innerhalb der Gruppe der aelteste zuerst.
  // Ein Testreel, das warten muss, wird uebersprungen und blockiert nichts.
  const due = queue.entries
    .filter((e) => e.status === 'ready' && new Date(e.scheduled_at) <= now)
    .sort((a, b) => (istTestreel(a) - istTestreel(b)) || (Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at)))
  let naechster = null
  for (const e of due) {
    const grund = testreelWartet(e, queue, now)
    if (!grund) { naechster = e; break }
    if (wartendGemeldet.get(e.id) !== grund.split(' ')[0]) {
      wartendGemeldet.set(e.id, grund.split(' ')[0])
      log(`${e.id} wartet: ${grund}`)
    }
  }

  const gepostet = naechster ? await postEntry(naechster, queue) : false

  // TikTok nach Instagram, damit ein Instagram-Slot nie auf TikTok wartet.
  // Ein Fehler dort darf den Instagram-Teil nie anhalten.
  try { await tiktokTakt(queue) } catch (e) { log(`TikTok-Takt fehlgeschlagen: ${e.message}`) }

  // Nur nach einem erfolgreichen Post sofort weiter (der naechste faellige
  // Eintrag wartet sonst unnoetig); sonst ruhen, statt im Kreis zu ziehen.
  if (!gepostet) await sleep(TICK_MS)
}

log('Waechter beendet, der naechste Lauf uebernimmt.')
