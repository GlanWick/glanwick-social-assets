#!/usr/bin/env node
// Prueft die TikTok-Anbindung, OHNE etwas zu veroeffentlichen.
// Laeuft als Workflow "TikTok Check" (von Hand), weil der Zernio-Schluessel
// nur als Secret existiert. Die Logs sind oeffentlich: Ausgegeben werden nur
// der Nutzername (steht ohnehin auf TikTok), Statuswerte und Dateigroessen.
//
//  1. Schluessel gueltig, TikTok-Konto verbunden und aktiv
//  2. Kontozustand: Verbindungsweg (business/developer), Posting-Recht, Token
//  3. Creator-Info: erlaubte Sichtbarkeit, Schalter, Werbekennzeichnung
//  4. Die naechsten Eintraege in Postreihenfolge, Release-Dateien erreichbar
//  5. Trockenlauf (dryRun) mit dem naechsten Eintrag: Zernio prueft den
//     kompletten Auftrag, legt aber nichts an und belegt kein Kontingent
//  6. Medienweg wie im Waechter: Cover per presign bei Zernio ablegen und
//     byte-gleich zurueckholen (nur eine Datei im Speicher, kein Beitrag)
//
// Rueckgabecode 1, sobald ein Punkt scheitert.

import { readFileSync } from 'node:fs'
import { kandidaten, block, zweiAmTag, REGELN } from './tiktok.mjs'

const ZERNIO = (process.env.ZERNIO_API_BASE || 'https://zernio.com/api') + '/v1'
const KEY = process.env.ZERNIO_API_KEY || ''
let fehler = 0
const ok = (t) => console.log(`OK      ${t}`)
const warn = (t) => console.log(`HINWEIS ${t}`)
const schlecht = (t) => { fehler++; console.log(`FEHLER  ${t}`) }

async function zernio(method, path, body) {
  const res = await fetch(ZERNIO + path, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) }
}

if (!KEY) {
  schlecht('Secret ZERNIO_API_KEY fehlt oder ist leer.')
  process.exit(1)
}

// 1. Konto
const konten = await zernio('GET', '/accounts?platform=tiktok')
if (konten.status === 401) { schlecht('Zernio lehnt den Schluessel ab (401).'); process.exit(1) }
if (konten.status !== 200) { schlecht(`Kontenabfrage HTTP ${konten.status}`); process.exit(1) }
const alle = (konten.json.accounts || []).filter((a) => a.platform === 'tiktok')
const aktiv = alle.filter((a) => a.isActive !== false && !a.needsReconnection && a.enabled !== false)
if (!alle.length) { schlecht('Bei Zernio ist kein TikTok-Konto verbunden.'); process.exit(1) }
for (const a of alle) console.log(`        Konto @${a.username}: ${a.isActive === false ? 'inaktiv' : 'aktiv'}${a.needsReconnection ? ', muss neu verbunden werden' : ''}`)
if (!aktiv.length) { schlecht('Kein TikTok-Konto ist aktiv.'); process.exit(1) }
const konto = aktiv[0]
ok(`TikTok-Konto @${konto.username} verbunden und aktiv`)
if (aktiv.length > 1) warn(`${aktiv.length} TikTok-Konten aktiv, der Waechter nimmt @${konto.username}`)

// 2. Kontozustand
const gesund = await zernio('GET', `/accounts/${konto._id}/health`)
if (gesund.status === 200) {
  const g = gesund.json
  console.log(`        Verbindungsweg: ${g.integrationLane || 'unbekannt'}, Zustand: ${g.status}, Token gueltig: ${g.tokenStatus?.valid}`)
  if (g.permissions?.canPost === false) schlecht(`Konto darf nicht posten. Fehlende Rechte: ${(g.permissions?.missingRequired || []).join(', ') || 'unbekannt'}`)
  else ok('Posting-Recht vorhanden')
  if (g.integrationLane && g.integrationLane !== 'business') warn('Konto haengt am Developer-Weg (geteiltes Tageskontingent). Neu verbinden hebt es auf den Business-Weg.')
  for (const i of g.issues || []) warn(`Zernio meldet: ${typeof i === 'string' ? i : JSON.stringify(i)}`)
} else warn(`Kontozustand nicht abrufbar (HTTP ${gesund.status})`)

// 3. Creator-Info
const info = await zernio('GET', `/accounts/${konto._id}/tiktok/creator-info?mediaType=video`)
if (info.status === 200) {
  const stufen = (info.json.privacyLevels || []).map((p) => p.value)
  console.log(`        Sichtbarkeit erlaubt: ${stufen.join(', ') || 'keine Angabe'}`)
  if (!stufen.includes('PUBLIC_TO_EVERYONE')) schlecht('PUBLIC_TO_EVERYONE ist fuer dieses Konto nicht erlaubt (Konto privat?).')
  else ok('Oeffentliches Posten erlaubt')
  if (info.json.creator?.canPostMore === false) schlecht('TikTok meldet: Konto kann gerade nicht weiter posten (Tageslimit).')
  const schalter = info.json.postingLimits?.interactionSettings || {}
  for (const [k, v] of Object.entries(schalter)) if (v && v.enabled === false) warn(`${k} ist in der TikTok-App abgeschaltet; der Waechter setzt ihn auf an, TikTok kann das ablehnen.`)
} else warn(`Creator-Info nicht abrufbar (HTTP ${info.status})`)

// 4. Reihenfolge und Dateien
const queue = JSON.parse(readFileSync(new URL('./queue.json', import.meta.url), 'utf8'))
const jetzt = Date.now()
const { gleichtakt, nachschuss, ab } = kandidaten(queue, jetzt)
const offen = queue.entries.filter((e) => block(e) && block(e).status === 'ready')
const wartetAufIg = offen.filter((e) => e.status !== 'published')
console.log(`        TikTok-Eintraege bereit: ${offen.length} (davon ${wartetAufIg.length} warten noch auf ihren Instagram-Post)`)
console.log(`        Takt: ${zweiAmTag(queue) ? `zwei am Tag (${REGELN.zeitenZwei.join(', ')} New York)` : `einer am Tag (${REGELN.zeitenEiner.join(', ')} New York)`}; Gleichtakt ${ab === null ? 'noch nicht aktiv (Top 12 laufen)' : 'aktiv'}`)
const reihe = [...gleichtakt, ...nachschuss].slice(0, 5)
for (const e of reihe) {
  const t = block(e)
  const url = t.video_url || e.video_url
  let groesse = 'keine Quelle'
  if (url) {
    try {
      const r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(30_000) })
      groesse = r.ok ? `${(Number(r.headers.get('content-length')) / 1048576).toFixed(1)} MB` : `HTTP ${r.status}`
      if (!r.ok) schlecht(`${e.id}: Video nicht abrufbar (HTTP ${r.status})`)
    } catch (err) { schlecht(`${e.id}: Video nicht abrufbar (${err.message})`) }
  } else schlecht(`${e.id}: keine Videoquelle`)
  console.log(`        naechster: ${t.nr ? `Nr. ${String(t.nr).padStart(2)}` : 'neu   '} ${e.slug.padEnd(26)} Video ${groesse}`)
}
for (const e of queue.entries.filter((x) => ['error', 'uebersprungen'].includes(block(x)?.status))) {
  warn(`${e.id}: ${block(e).status} (${block(e).fehler || 'ohne Text'})`)
}

// 5. Trockenlauf
const probe = reihe[0]
if (probe) {
  const t = block(probe)
  const r = await zernio('POST', '/posts', {
    content: t.caption ?? probe.caption ?? '',
    mediaItems: [{ type: 'video', url: t.video_url || probe.video_url }],
    platforms: [{ platform: 'tiktok', accountId: konto._id }],
    tiktokSettings: {
      privacy_level: 'PUBLIC_TO_EVERYONE', allow_comment: true, allow_duet: true, allow_stitch: true,
      content_preview_confirmed: true, express_consent_given: true, video_made_with_ai: true,
      commercialContentType: 'none',
    },
    // Doppelt gesichert: Selbst wenn Zernio dryRun einmal ignorieren sollte,
    // entsteht mit isDraft nur ein Zernio-Entwurf, der nie veroeffentlicht wird.
    isDraft: true,
    dryRun: true,
  })
  if (r.status === 200 && r.json.dryRun) {
    if (r.json.canPublish) ok(`Trockenlauf mit ${probe.slug}: Zernio wuerde jetzt veroeffentlichen`)
    else schlecht(`Trockenlauf mit ${probe.slug}: nicht veroeffentlichbar (${JSON.stringify(r.json.tiktok || [])})`)
  } else if ((r.status === 200 || r.status === 201) && r.json.post?._id) {
    const weg = await zernio('DELETE', `/posts/${r.json.post._id}`)
    warn(`Zernio hat statt des Trockenlaufs einen Entwurf angelegt (nie veroeffentlicht), wieder geloescht: HTTP ${weg.status}`)
  } else schlecht(`Trockenlauf HTTP ${r.status}: ${r.json.error || JSON.stringify(r.json).slice(0, 300)}`)
} else warn('Kein Eintrag bereit, Trockenlauf entfaellt.')

// 6. Medienweg wie im Waechter, ohne zu posten: Cover des naechsten Eintrags
//    laden, per presign bei Zernio ablegen, oeffentliche Datei gegenpruefen.
//    Legt nur eine Datei in Zernios Speicher ab, keinen Beitrag.
if (probe) {
  const t = block(probe)
  const quelle = t.cover_url || probe.cover_url
  try {
    const q = await fetch(quelle, { redirect: 'follow', signal: AbortSignal.timeout(60_000) })
    const daten = Buffer.from(await q.arrayBuffer())
    if (!q.ok || daten.length < 10_000) throw new Error(`Quelle HTTP ${q.status}, ${daten.length} Bytes`)
    const p = await zernio('POST', '/media/presign', { filename: `pruefung-${probe.slug}-cover.jpg`, contentType: 'image/jpeg', size: daten.length })
    if (p.status !== 200 || !p.json.uploadUrl || !p.json.publicUrl) throw new Error(`Presign HTTP ${p.status} ${p.json.error || ''}`)
    const put = await fetch(p.json.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: daten, signal: AbortSignal.timeout(60_000) })
    if (!put.ok) throw new Error(`Upload HTTP ${put.status}`)
    const h = await fetch(p.json.publicUrl, { signal: AbortSignal.timeout(60_000) })
    const zurueck = Buffer.from(await h.arrayBuffer())
    const typ = h.headers.get('content-type') || ''
    if (h.ok && zurueck.equals(daten) && typ.startsWith('image/jpeg')) ok(`Medienweg: ${daten.length} Bytes hochgeladen und byte-gleich abrufbar (${typ})`)
    else schlecht(`Medienweg: Abruf HTTP ${h.status}, ${zurueck.length} von ${daten.length} Bytes, Typ ${typ || 'leer'}`)
  } catch (err) {
    schlecht(`Medienweg: ${err.message}`)
  }
}

console.log(fehler ? `\n${fehler} Problem(e), siehe FEHLER oben.` : '\nAlles bereit. Der Waechter postet ab dem naechsten Fenster.')
process.exit(fehler ? 1 : 0)
