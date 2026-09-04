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

import { readFileSync, writeFileSync } from 'node:fs'
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

function saveAndPush(queue, message) {
  writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2) + '\n')
  git('config', 'user.name', 'glanwick-social-bot')
  git('config', 'user.email', 'noreply@glanwick.com')
  git('add', 'queue.json')
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
    const container = await api('POST', '/me/media', {
      media_type: 'REELS',
      video_url: entry.video_url,
      caption: entry.caption,
      share_to_feed: 'true',
      is_ai_generated: 'true',
    })
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
    saveAndPush(queue, `[skip ci] Queue: ${entry.id} veroeffentlicht`)
    log(`VEROEFFENTLICHT ${entry.id} ${media.permalink}`)
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
