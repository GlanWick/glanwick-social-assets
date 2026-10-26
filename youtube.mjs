// YouTube-Teil des Waechters: laedt YouTube-Bloecke aus queue.json als Shorts
// auf den eigenen Kanal hoch, direkt ueber die YouTube Data API, ohne
// Fremddienst. post-due.mjs ruft takt(queue) einmal je Pruefung auf, nach dem
// Instagram- und dem TikTok-Teil.
//
// WARUM DIREKT
// Seit Oktober 2026 landen Uploads aus ungeprueften API-Projekten nicht mehr
// auf privat ("Videos uploaded from unverified API projects are not restricted
// to private viewing mode", videos.insert, Stand 15.10.2026). Ein Upload kostet
// 1 Einheit im eigenen Upload-Topf, 100 Uploads am Tag sind frei. Jan will seit
// 23.10.2026 keinen Fremddienst zum Posten (kein Zernio).
//
// ZUGANG
// OAuth-Client (Desktop-App) plus Refresh-Token des Kanalinhabers, angelegt mit
// `node scripts/credentials-setup.mjs youtube-oauth` im privaten Repo. Secrets:
// YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN. Der
// OAuth-Zustimmungsbildschirm muss auf "In production" stehen; im Status
// "Testing" laeuft der Refresh-Token nach 7 Tagen ab.
//
// DATENMODELL
// Ein Queue-Eintrag geht auf YouTube, wenn er einen Block "youtube" traegt:
//   status     ready | posting | published | error | uebersprungen
//              (draft = angehalten, wird nie hochgeladen)
//   video_url  Release-Datei (releases/download/tiktok/...), wie bei TikTok:
//              Der Instagram-Teil loescht seine Pages-Dateien nach dem Post
//   title      optional, sonst die erste Zeile der Caption
//   description optional, sonst die Caption
//   versuch    Standard 1; wer einen Eintrag nach einem Fehler neu anstoesst,
//              erhoeht ihn um eins
// Ergebnisfelder schreibt nur dieser Waechter: video_id, url, published_at,
// gestartet_at, fehler, fehler_at, fehlversuche, stand.
//
// WANN HOCHGELADEN WIRD
//  - Immer erst NACH dem Instagram-Post (status "published"). Das Review-Gate
//    "draft" und zurueckgezogene Eintraege gelten damit auch hier.
//  - Aeltester Instagram-Post zuerst, mindestens 60 Minuten Abstand, hoechstens
//    4 Uploads in 24 Stunden. Ein Rueckstau laeuft so langsam ab statt auf einmal.
//
// DOPPELPOST-SCHUTZ
// YouTube kennt keinen Idempotenz-Schluessel. Deshalb:
//  1. Der Eintrag wird vor dem Upload auf "posting" gesetzt und gepusht.
//  2. Jedes Video traegt das Schlagwort "gwq-<id>". Vor jedem Upload werden die
//     letzten Uploads des Kanals danach durchsucht (3 Einheiten). Ist es schon
//     da, wird der Eintrag mit diesem Video abgeschlossen, nicht neu geladen.
//  3. Je Slug hoechstens ein YouTube-Video, auch wenn die Queue ihn doppelt fuehrt.
//
// LOG-DISZIPLIN wie im Instagram-Teil: Das Repo ist oeffentlich. Nie einen
// Token und nie eine Upload-Adresse ausgeben, nur Queue-IDs, Status und
// YouTube-Links, die ohnehin oeffentlich sind.

const TOKEN_URL = process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token'
const API = process.env.YOUTUBE_API_BASE || 'https://www.googleapis.com/youtube/v3'
const UPLOAD = process.env.YOUTUBE_UPLOAD_BASE || 'https://www.googleapis.com/upload/youtube/v3'

export const REGELN = {
  abstandMin: Number(process.env.YOUTUBE_ABSTAND_MIN || 60),
  proTag: Number(process.env.YOUTUBE_PRO_TAG || 4),
  haengtMin: 20,
  maxFehlversuche: 5,
  // Bildung. Passt zu Erklaervideos ueber Risiko und Journal.
  kategorie: '27',
}

const BELEGT = new Set(['posting', 'published'])

export const block = (e) => (e && e.youtube && typeof e.youtube === 'object' ? e.youtube : null)
const ms = (iso) => (iso ? Date.parse(iso) : NaN)
const iso = (t) => new Date(t).toISOString()
const igLive = (e) => e.status === 'published' && !Number.isNaN(ms(e.published_at))
export const marke = (e) => `gwq-${e.id}`

// ---------------------------------------------------------------------------
// Titel und Beschreibung aus der Instagram-Caption, als reine Funktionen
// (getestet in youtube.test.mjs).
// ---------------------------------------------------------------------------

// YouTube erlaubt 100 Zeichen und kein "<" oder ">".
export function titelAus(caption) {
  const erste = String(caption || '').split('\n').map((z) => z.trim()).find(Boolean) || ''
  const t = erste.replace(/#[\p{L}\p{N}_]+/gu, '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim()
  const zeichen = [...t]
  if (zeichen.length <= 100) return t
  const kurz = zeichen.slice(0, 99).join('')
  const schnitt = kurz.lastIndexOf(' ')
  return (schnitt > 60 ? kurz.slice(0, schnitt) : kurz).replace(/[\s,;:.]+$/, '') + '…'
}

// "link in bio" gibt es auf YouTube nicht, und mit dem kostenlosen Journal wird
// seit 23.10.2026 nicht mehr geworben (Jan). Beide Schlusszeilen werden zur
// Adresse; was danach noch "free journal" sagt, geht nicht raus.
export function beschreibungAus(caption) {
  const text = String(caption || '')
    .split('\n')
    .map((z) => (/^\s*(free|your) journal, link in bio\.?\s*$/i.test(z) ? 'Your journal: glanwick.com' : z))
    .join('\n')
    .replace(/[<>]/g, '')
    .trim()
  if (/free journal/i.test(text)) throw fest('Caption wirbt mit "free journal", das geht nicht auf YouTube')
  if (/link in bio/i.test(text)) throw fest('Caption verweist auf "link in bio", das gibt es auf YouTube nicht')
  // 5.000 Bytes erlaubt YouTube.
  if (Buffer.byteLength(text) > 5000) throw fest(`Beschreibung hat ${Buffer.byteLength(text)} Bytes, YouTube erlaubt 5.000`)
  return text
}

export function kandidaten(queue) {
  return queue.entries
    .filter((e) => block(e)?.status === 'ready' && igLive(e))
    .sort((a, b) => ms(a.published_at) - ms(b.published_at))
}

export const schonAufYouTube = (queue, e) =>
  queue.entries.some((x) => x !== e && x.slug === e.slug && BELEGT.has(block(x)?.status))

const starts = (queue, nur) => queue.entries
  .map(block)
  .filter((y) => y && (!nur || nur.has(y.status)))
  .map((y) => ms(y.gestartet_at))
  .filter((x) => !Number.isNaN(x))
// Der Abstand zaehlt auch fehlgeschlagene Versuche (so warten Wiederholungen),
// die Tagesgrenze nur Uploads, die laufen oder durch sind.
export const letzterStart = (queue) => Math.max(0, ...starts(queue))
export const uploadsIn24h = (queue, jetzt) => starts(queue, BELEGT).filter((t) => jetzt - t < 24 * 3600_000).length

// ---------------------------------------------------------------------------
// Fehlerarten wie im TikTok-Teil: "voruebergehend" wird wiederholt, "fest"
// braucht einen Menschen, "auth" pausiert den YouTube-Teil, "kontingent"
// pausiert ihn bis nach dem Tageswechsel des Kontingents.
// ---------------------------------------------------------------------------
class YouTubeFehler extends Error {
  constructor(art, text) { super(text); this.art = art }
}
const voruebergehend = (t) => new YouTubeFehler('voruebergehend', t)
const fest = (t) => new YouTubeFehler('fest', t)
const auth = (t) => new YouTubeFehler('auth', t)
const kontingent = (t) => new YouTubeFehler('kontingent', t)

// Google-Fehler nach Art einordnen. "reason" steht in error.errors[0].reason.
function einordnen(status, json, wo) {
  const grund = json?.error?.errors?.[0]?.reason || json?.error?.status || ''
  const text = `${wo}: HTTP ${status}${grund ? ` (${grund})` : ''}${json?.error?.message ? ` ${json.error.message}` : ''}`.slice(0, 300)
  if (status === 401) return auth(text)
  if (status === 403 && /quotaExceeded|uploadLimitExceeded|dailyLimitExceeded|rateLimitExceeded/i.test(grund)) return kontingent(text)
  if (status === 403) return auth(text)
  if (status === 429) return kontingent(text)
  if (status >= 500) return voruebergehend(text)
  return fest(text)
}

export function erstelleYouTube({
  saveAndPush, notify, log, fetchImpl = fetch, jetzt = () => Date.now(),
  zugang = {
    clientId: process.env.YOUTUBE_CLIENT_ID || '',
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET || '',
    refreshToken: process.env.YOUTUBE_REFRESH_TOKEN || '',
  },
}) {
  let token = null
  let tokenBis = 0
  let uploadsListe = null
  let pausiertBis = 0
  const gemeldet = new Set()

  const einmal = (schluessel, fn) => { if (!gemeldet.has(schluessel)) { gemeldet.add(schluessel); fn() } }
  const berlin = () => new Date(jetzt()).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' })

  async function holen(url, opt = {}, timeoutMs = 60_000) {
    try {
      return await fetchImpl(url, { ...opt, signal: AbortSignal.timeout(timeoutMs) })
    } catch (e) {
      throw voruebergehend(`YouTube nicht erreichbar (${e.name === 'TimeoutError' ? 'Zeitlimit' : e.message})`)
    }
  }

  async function zugriff() {
    if (token && jetzt() < tokenBis) return token
    const res = await holen(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: zugang.clientId, client_secret: zugang.clientSecret,
        refresh_token: zugang.refreshToken, grant_type: 'refresh_token',
      }),
    })
    const json = await res.json().catch(() => ({}))
    // invalid_grant: Token widerrufen, abgelaufen (Status "Testing") oder Passwort geaendert.
    if (res.status === 400 || res.status === 401) throw auth(`Google lehnt den Refresh-Token ab (${json.error || res.status})`)
    if (!res.ok || !json.access_token) throw voruebergehend(`Token-Abruf HTTP ${res.status}`)
    token = json.access_token
    tokenBis = jetzt() + Math.max(60, Number(json.expires_in || 3600) - 120) * 1000
    return token
  }

  async function lesen(pfad, params) {
    const url = new URL(API + pfad)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
    const res = await holen(url, { headers: { Authorization: `Bearer ${await zugriff()}` } })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw einordnen(res.status, json, `GET ${pfad}`)
    return json
  }

  // Sucht in den letzten 50 Uploads des Kanals das Video mit der Marke des
  // Eintrags. Kostet 3 Einheiten (Kanal, Uploadliste, Videos).
  async function schonHochgeladen(e) {
    if (!uploadsListe) {
      const k = await lesen('/channels', { part: 'contentDetails', mine: 'true' })
      uploadsListe = k.items?.[0]?.contentDetails?.relatedPlaylists?.uploads
      if (!uploadsListe) throw auth('Zum Google-Konto gehoert kein YouTube-Kanal')
    }
    const liste = await lesen('/playlistItems', { part: 'contentDetails', playlistId: uploadsListe, maxResults: '50' })
    const ids = (liste.items || []).map((i) => i.contentDetails?.videoId).filter(Boolean)
    if (!ids.length) return null
    const videos = await lesen('/videos', { part: 'snippet', id: ids.join(',') })
    return (videos.items || []).find((v) => (v.snippet?.tags || []).includes(marke(e)))?.id || null
  }

  // Laedt die Datei aus dem Release. GitHub leitet auf einen Speicher um.
  async function datei(quelle) {
    const res = await holen(quelle, { redirect: 'follow' }, 180_000)
    if (res.status === 404) throw fest('Video fehlt an der Quelle (404)')
    if (!res.ok) throw voruebergehend(`Video: Quelle HTTP ${res.status}`)
    const daten = Buffer.from(await res.arrayBuffer())
    if (daten.length < 500_000) throw fest(`Video hat nur ${daten.length} Bytes`)
    return daten
  }

  async function hochladen(e, daten, titel, beschreibung) {
    const meta = {
      snippet: {
        title: titel,
        description: beschreibung,
        tags: ['trading journal', 'risk management', 'trading', marke(e)],
        categoryId: REGELN.kategorie,
        defaultLanguage: 'en',
        defaultAudioLanguage: 'en',
      },
      status: {
        privacyStatus: 'public',
        selfDeclaredMadeForKids: false,
        // KI-Kennzeichnung wie auf Instagram und TikTok: an, ausser der Eintrag
        // sagt ausdruecklich ki_kennzeichnung: false.
        containsSyntheticMedia: e.ki_kennzeichnung !== false,
        embeddable: true,
        license: 'youtube',
      },
    }
    const start = await holen(`${UPLOAD}/videos?uploadType=resumable&part=snippet,status`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await zugriff()}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'video/mp4',
        'X-Upload-Content-Length': String(daten.length),
      },
      body: JSON.stringify(meta),
    })
    if (!start.ok) throw einordnen(start.status, await start.json().catch(() => ({})), 'Upload-Start')
    const ziel = start.headers.get('location')
    if (!ziel) throw voruebergehend('Upload-Start ohne Zieladresse')
    const res = await holen(ziel, { method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: daten }, 600_000)
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw einordnen(res.status, json, 'Upload')
    if (!json.id) throw voruebergehend('Upload ohne Video-ID beendet')
    return json.id
  }

  function veroeffentlicht(e, queue, videoId, hinweis) {
    const y = block(e)
    y.status = 'published'
    y.video_id = videoId
    y.url = `https://www.youtube.com/shorts/${videoId}`
    y.published_at = iso(jetzt())
    y.stand = y.published_at
    delete y.fehler
    delete y.fehlversuche
    saveAndPush(queue, `[skip ci] YouTube: ${e.id} veroeffentlicht`)
    log(`YouTube VEROEFFENTLICHT ${e.id} ${y.url}${hinweis ? ` (${hinweis})` : ''}`)
    notify(`YouTube live um ${berlin()} Berlin: ${e.slug}\n${y.url}`)
  }

  function pausieren(minuten, grund) {
    pausiertBis = jetzt() + minuten * 60_000
    log(`YouTube pausiert ${minuten} Minuten: ${grund}`)
    einmal(`pause:${grund.slice(0, 60)}`, () => notify(`YouTube pausiert: ${grund}\nNichts geht verloren, die Eintraege warten. Loesung steht in docs/marketing/youtube/YOUTUBE-AUTOPILOT.md (privates Repo).`))
  }

  function fehlerBehandeln(e, queue, err) {
    const y = block(e)
    const art = err instanceof YouTubeFehler ? err.art : 'voruebergehend'
    y.stand = iso(jetzt())
    if (art === 'fest' || (art === 'voruebergehend' && (y.fehlversuche || 0) + 1 >= REGELN.maxFehlversuche)) {
      y.status = 'error'
      y.fehler = err.message
      y.fehler_at = iso(jetzt())
      saveAndPush(queue, `[skip ci] YouTube: ${e.id} fehlgeschlagen`)
      log(`YouTube FEHLER ${e.id}: ${err.message}`)
      notify(`YouTube-Fehler bei ${e.slug}: ${err.message}\nDer Eintrag bleibt stehen, die anderen laufen weiter.`)
      return
    }
    if (art === 'voruebergehend') y.fehlversuche = (y.fehlversuche || 0) + 1
    // Zurueck in die Warteschlange; der Startzeitpunkt bleibt fuer den Abstand stehen.
    y.status = 'ready'
    saveAndPush(queue, `[skip ci] YouTube: ${e.id} wird spaeter erneut versucht`)
    log(`YouTube: ${e.id} spaeter erneut (${err.message})`)
    if (art === 'auth') { token = null; uploadsListe = null; pausieren(30, err.message) }
    // Das Kontingent setzt Google um Mitternacht Pazifikzeit zurueck; drei
    // Stunden Pause halten die Zahl der Fehlversuche klein.
    if (art === 'kontingent') pausieren(180, err.message)
  }

  async function posten(e, queue) {
    const y = block(e)
    y.status = 'posting'
    y.gestartet_at = iso(jetzt())
    y.stand = y.gestartet_at
    y.versuch = y.versuch || 1
    saveAndPush(queue, `[skip ci] YouTube: ${e.id} wird hochgeladen`)
    log(`YouTube POST ${e.id}`)
    try {
      const caption = e.caption || ''
      const titel = y.title ?? titelAus(caption)
      if (!titel) throw fest('Kein Titel: Caption und Feld title sind leer')
      const beschreibung = y.description ?? beschreibungAus(caption)
      const vorhanden = await schonHochgeladen(e)
      if (vorhanden) return veroeffentlicht(e, queue, vorhanden, 'war schon hochgeladen')
      // Ohne eigene Quelle die Release-Datei des TikTok-Blocks, nie Pages.
      const quelle = y.video_url || e.tiktok?.video_url
      if (!quelle) throw fest('Keine Videoquelle im Eintrag')
      const daten = await datei(quelle)
      const id = await hochladen(e, daten, titel, beschreibung)
      veroeffentlicht(e, queue, id)
    } catch (err) {
      fehlerBehandeln(e, queue, err)
    }
  }

  let ohneZugangGemeldet = false

  return async function takt(queue) {
    if (!zugang.clientId || !zugang.clientSecret || !zugang.refreshToken) {
      if (!ohneZugangGemeldet) { log('YouTube: YOUTUBE_CLIENT_ID/SECRET/REFRESH_TOKEN fehlen, der YouTube-Teil ruht.'); ohneZugangGemeldet = true }
      return
    }
    const jetztMs = jetzt()

    // 1. Haengengebliebenes "posting" freigeben. Der naechste Versuch sucht
    //    zuerst nach der Marke, ein schon hochgeladenes Video kommt also nicht
    //    ein zweites Mal.
    for (const e of queue.entries) {
      const y = block(e)
      if (y?.status === 'posting' && jetztMs - ms(y.gestartet_at) > REGELN.haengtMin * 60_000) {
        y.status = 'ready'
        y.stand = iso(jetztMs)
        saveAndPush(queue, `[skip ci] YouTube: ${e.id} zurueck auf ready (haengengeblieben)`)
        log(`YouTube: ${e.id} hing, wieder auf ready.`)
      }
    }

    if (jetztMs < pausiertBis) return

    // 2. Abstand und Tagesgrenze.
    if (jetztMs - letzterStart(queue) < REGELN.abstandMin * 60_000) return
    if (uploadsIn24h(queue, jetztMs) >= REGELN.proTag) return

    // 3. Doppelte Slugs aussortieren, dann der aelteste Instagram-Post zuerst.
    for (const e of kandidaten(queue)) {
      if (!schonAufYouTube(queue, e)) continue
      const y = block(e)
      y.status = 'uebersprungen'
      y.fehler = 'Slug ist schon auf YouTube'
      y.stand = iso(jetztMs)
      saveAndPush(queue, `[skip ci] YouTube: ${e.id} uebersprungen (Slug schon auf YouTube)`)
      log(`YouTube: ${e.id} uebersprungen, ${e.slug} ist schon auf YouTube.`)
    }
    const naechster = kandidaten(queue)[0]
    if (!naechster) return
    // Zugang pruefen, bevor der Eintrag auf "posting" geht: Ein abgelaufener
    // Token soll keinen Eintrag anfassen, nur pausieren und einmal melden.
    try {
      await zugriff()
    } catch (err) {
      if (err.art === 'auth') pausieren(30, err.message)
      else log(`YouTube: Token-Abruf fehlgeschlagen (${err.message})`)
      return
    }
    return posten(naechster, queue)
  }
}
