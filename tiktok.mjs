// TikTok-Teil des Waechters: postet TikTok-Bloecke aus queue.json ueber Zernio.
// post-due.mjs ruft takt(queue) einmal je Pruefung auf, nach dem Instagram-Teil.
//
// WARUM ZERNIO
// TikTok laesst fremde Apps nur nach einem Audit oeffentlich posten. Ein
// Werkzeug, das nur die eigenen Konten bespielt, besteht dieses Audit nie: Die
// Content-Sharing-Guidelines fuehren "A utility tool to help upload contents to
// the account(s) you or your team manages" ausdruecklich als unzulaessig. Ohne
// Audit landet jeder Beitrag auf privat. Zernio ist eine gepruefte App mit
// Schnittstelle (zwei Konten kostenlos, Beitraege unbegrenzt). Higgsfield
// scheidet aus, weil dort jeder Beitrag in einem Formular von Hand bestaetigt
// werden muss. Pruefung vom 26.09.2026, Details in
// docs/marketing/tiktok/TIKTOK-AUTOPILOT.md im privaten Repo.
//
// DATENMODELL
// Ein Queue-Eintrag geht auf TikTok, wenn er einen Block "tiktok" traegt:
//   status     ready | posting | submitted | published | error | uebersprungen
//              (draft = angehalten, wird nie gepostet)
//   nr         Platz im Nachschuss der 35 Stick-Man-Videos; fehlt bei neuen Reels
//   video_url  Release-Datei (releases/download/tiktok/...), nicht GitHub Pages:
//              Pages traegt nur 1 GB, und der Instagram-Teil loescht seine
//              Dateien direkt nach dem Instagram-Post
//   cover_url  Release-Datei des Covers
//   caption    optional, sonst die Instagram-Caption
//   versuch    Teil des Idempotenz-Schluessels (Standard 1). Wer einen Eintrag
//              nach einem Fehler erneut schickt, erhoeht ihn um eins.
// Ergebnisfelder schreibt nur dieser Waechter: post_id, url, plattform_id,
// published_at, gestartet_at, slot, fehler, fehler_at, fehlversuche, stand.
//
// WANN GEPOSTET WIRD
//  - Immer erst NACH dem Instagram-Post (status "published"). Das Review-Gate
//    "draft" und zurueckgezogene Eintraege gelten damit auch fuer TikTok.
//  - Nachschuss: alles mit nr, danach aeltere Reels ohne nr. Rollende Fenster
//    nach New Yorker Zeit, zwei am Tag (13:00, 19:00), solange einer der Top 12
//    offen ist, danach einer (13:00). Ein verpasstes Fenster wird nicht
//    nachgeholt, es entsteht also nie ein Stau, der auf einmal rausgeht - auch
//    nicht, wenn das Konto erst Tage spaeter verbunden wird.
//  - Gleichtakt: Sobald die Top 12 durch sind, geht jedes neue Reel ohne nr
//    direkt nach seinem Instagram-Post auch auf TikTok.
//  - Zwischen zwei TikTok-Posts liegen mindestens 40 Minuten.
//
// DOPPELPOST-SCHUTZ
//  1. Der Eintrag wird vor dem Aufruf auf "posting" gesetzt und gepusht.
//  2. Idempotency-Key je Eintrag und Versuch: Ein zweiter Aufruf innerhalb von
//     24 Stunden liefert bei Zernio den ersten Beitrag zurueck, keinen neuen.
//  3. Je Slug hoechstens ein TikTok-Post, auch wenn die Queue ihn doppelt fuehrt.
//
// LOG-DISZIPLIN wie im Instagram-Teil: Das Repo ist oeffentlich. Nie den
// Schluessel und nie eine Upload-URL ausgeben, nur Queue-IDs, Status und
// TikTok-Links, die ohnehin oeffentlich sind.

const ZERNIO = (process.env.ZERNIO_API_BASE || 'https://zernio.com/api') + '/v1'

const zeitenAus = (wert, standard) => (wert ? wert.split(',').map((s) => s.trim()).filter(Boolean) : standard)

export const REGELN = {
  zeitenZwei: zeitenAus(process.env.TIKTOK_ZEITEN_ZWEI, ['13:00', '19:00']),
  zeitenEiner: zeitenAus(process.env.TIKTOK_ZEITEN_EINER, ['13:00']),
  topBis: 12,
  fensterMin: 90,
  abstandMin: Number(process.env.TIKTOK_ABSTAND_MIN || 40),
  frischMin: 180,
  haengtMin: 20,
  submittedMaxMin: 360,
  urlSucheMaxMin: 180,
  maxFehlversuche: 5,
}

const OFFEN = new Set(['ready', 'posting', 'submitted'])
const BELEGT = new Set(['posting', 'submitted', 'published'])

export const block = (e) => (e && e.tiktok && typeof e.tiktok === 'object' ? e.tiktok : null)
const ms = (iso) => (iso ? Date.parse(iso) : NaN)
const iso = (t) => new Date(t).toISOString()
const igLive = (e) => e.status === 'published' && !Number.isNaN(ms(e.published_at))

// ---------------------------------------------------------------------------
// New Yorker Zeit ohne Bibliothek. Nie mit festem Versatz rechnen: Die USA
// stellen am 01.11.2026 zurueck, Deutschland schon am 25.10.
// ---------------------------------------------------------------------------
const NY_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
})

export function nyTeile(datum) {
  const p = Object.fromEntries(NY_FORMAT.formatToParts(datum).map((x) => [x.type, x.value]))
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute) }
}

export function nyZuUtc(y, mo, d, h, mi) {
  const soll = Date.UTC(y, mo - 1, d, h, mi)
  let t = soll
  for (let i = 0; i < 3; i++) {
    const p = nyTeile(new Date(t))
    t += soll - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi)
  }
  return new Date(t)
}

// Beginn des Fensters, in dem "jetzt" liegt, oder null.
export function offenesFenster(jetzt, zeiten, fensterMin = REGELN.fensterMin) {
  const heute = nyTeile(jetzt)
  for (const versatz of [0, -1]) {
    const tag = new Date(Date.UTC(heute.y, heute.mo - 1, heute.d + versatz))
    for (const z of zeiten) {
      const [h, mi] = z.split(':').map(Number)
      const start = nyZuUtc(tag.getUTCFullYear(), tag.getUTCMonth() + 1, tag.getUTCDate(), h, mi)
      if (jetzt >= start && jetzt - start < fensterMin * 60_000) return start
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Reihenfolge und Takt, als reine Funktionen (getestet in tiktok.test.mjs).
// ---------------------------------------------------------------------------
const istTop = (t) => t && Number.isInteger(t.nr) && t.nr >= 1 && t.nr <= REGELN.topBis

// Ab wann der Gleichtakt gilt: Zeitpunkt, an dem der letzte der Top 12 fertig
// wurde. null, solange einer davon noch offen ist.
export function gleichtaktAb(queue) {
  const top = queue.entries.map(block).filter(istTop)
  if (top.some((t) => OFFEN.has(t.status))) return null
  const zeiten = top.map((t) => ms(t.published_at || t.fehler_at || t.stand)).filter((x) => !Number.isNaN(x))
  return zeiten.length ? Math.max(...zeiten) : 0
}

export const zweiAmTag = (queue) => queue.entries.map(block).some((t) => istTop(t) && OFFEN.has(t.status))

export function kandidaten(queue, jetzt) {
  const ab = gleichtaktAb(queue)
  const gleichtakt = []
  const nachschuss = []
  for (const e of queue.entries) {
    const t = block(e)
    if (!t || t.status !== 'ready' || !igLive(e)) continue
    const igAt = ms(e.published_at)
    const frisch = jetzt - igAt <= REGELN.frischMin * 60_000
    if (t.nr == null && ab !== null && igAt >= ab && frisch) gleichtakt.push(e)
    else nachschuss.push(e)
  }
  gleichtakt.sort((a, b) => ms(a.published_at) - ms(b.published_at))
  nachschuss.sort((a, b) => (block(a).nr ?? 1e9) - (block(b).nr ?? 1e9) || ms(a.published_at) - ms(b.published_at))
  return { gleichtakt, nachschuss, ab }
}

export const schonAufTikTok = (queue, e) =>
  queue.entries.some((x) => x !== e && x.slug === e.slug && BELEGT.has(block(x)?.status))

export function letzterStart(queue) {
  const zeiten = queue.entries.map((e) => ms(block(e)?.gestartet_at)).filter((x) => !Number.isNaN(x))
  return zeiten.length ? Math.max(...zeiten) : 0
}

// ---------------------------------------------------------------------------
// Fehlerarten: "voruebergehend" wird wiederholt, "fest" braucht einen Menschen,
// "auth" pausiert den TikTok-Teil (Schluessel falsch, Konto getrennt).
// ---------------------------------------------------------------------------
class TikTokFehler extends Error {
  constructor(art, text) { super(text); this.art = art }
}
const voruebergehend = (t) => new TikTokFehler('voruebergehend', t)
const fest = (t) => new TikTokFehler('fest', t)
const auth = (t) => new TikTokFehler('auth', t)

export function erstelleTikTok({ saveAndPush, notify, log, fetchImpl = fetch, jetzt = () => Date.now(), schluessel = process.env.ZERNIO_API_KEY || '' }) {
  let konto = null
  let kontoGeprueft = 0
  let pausiertBis = 0
  const gemeldet = new Set()
  const zuletztNachgefasst = new Map()

  const einmal = (schluesselText, fn) => { if (!gemeldet.has(schluesselText)) { gemeldet.add(schluesselText); fn() } }
  const berlin = () => new Date(jetzt()).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' })

  async function zernio(method, path, body, kopf = {}, timeoutMs = 60_000) {
    let res
    try {
      res = await fetchImpl(ZERNIO + path, {
        method,
        headers: { Authorization: `Bearer ${schluessel}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...kopf },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      throw voruebergehend(`Zernio nicht erreichbar (${e.name === 'TimeoutError' ? 'Zeitlimit' : e.message})`)
    }
    const json = await res.json().catch(() => ({}))
    return { status: res.status, json }
  }

  function pausieren(grund) {
    pausiertBis = jetzt() + 30 * 60_000
    log(`TikTok pausiert 30 Minuten: ${grund}`)
    einmal(`pause:${grund}`, () => notify(`TikTok pausiert: ${grund}\nNichts geht verloren, die Eintraege warten. Loesung steht in TIKTOK-AUTOPILOT.md (Abschnitt Stoerungen).`))
  }

  async function kontoHolen() {
    kontoGeprueft = jetzt()
    const r = await zernio('GET', '/accounts?platform=tiktok')
    if (r.status === 401) { konto = null; pausieren('Zernio lehnt den API-Schluessel ab (401).'); return }
    if (r.status !== 200) { log(`TikTok: Kontenabfrage HTTP ${r.status}`); return }
    const alle = (r.json.accounts || []).filter((a) => a.platform === 'tiktok')
    const aktiv = alle.filter((a) => a.isActive !== false && !a.needsReconnection && a.enabled !== false)
    const vorher = konto?._id
    konto = aktiv[0] || null
    if (!konto) {
      if (alle.length) pausieren('Das TikTok-Konto muss in Zernio neu verbunden werden.')
      else einmal('kein-konto', () => log('TikTok: Bei Zernio ist noch kein TikTok-Konto verbunden, TikTok-Teil wartet.'))
      return
    }
    if (konto._id !== vorher) log(`TikTok: Konto @${konto.username} ist aktiv.`)
  }

  // Laedt eine Datei (Release oder Pages) und legt sie mit korrektem Typ bei
  // Zernio ab. GitHub liefert Release-Dateien als application/octet-stream aus;
  // Zernio verlangt fuer fremde URLs den richtigen Typ, deshalb der Umweg.
  async function umziehen(quelle, typ, name, minBytes) {
    let res
    try {
      res = await fetchImpl(quelle, { redirect: 'follow', signal: AbortSignal.timeout(180_000) })
    } catch (e) {
      throw voruebergehend(`${name} nicht ladbar (${e.message})`)
    }
    if (res.status === 404) throw fest(`${name} fehlt an der Quelle (404)`)
    if (!res.ok) throw voruebergehend(`${name}: Quelle HTTP ${res.status}`)
    const daten = Buffer.from(await res.arrayBuffer())
    if (daten.length < minBytes) throw fest(`${name} hat nur ${daten.length} Bytes`)
    const p = await zernio('POST', '/media/presign', { filename: name, contentType: typ, size: daten.length })
    if (p.status === 401 || p.status === 403) throw auth(`Zernio lehnt den Upload ab (${p.status})`)
    if (p.status === 429 || p.status >= 500) throw voruebergehend(`Presign ${name}: HTTP ${p.status}`)
    if (p.status !== 200 || !p.json.uploadUrl || !p.json.publicUrl) throw fest(`Presign ${name}: HTTP ${p.status} ${p.json.error || ''}`.trim())
    let put
    try {
      put = await fetchImpl(p.json.uploadUrl, { method: 'PUT', headers: { 'Content-Type': typ }, body: daten, signal: AbortSignal.timeout(300_000) })
    } catch (e) {
      throw voruebergehend(`Upload ${name} abgebrochen (${e.message})`)
    }
    if (!put.ok) throw (put.status >= 500 ? voruebergehend : fest)(`Upload ${name}: HTTP ${put.status}`)
    return p.json.publicUrl
  }

  function veroeffentlicht(e, queue, pl) {
    const t = block(e)
    t.status = 'published'
    t.published_at = pl.publishedAt || iso(jetzt())
    t.url = pl.platformPostUrl || null
    t.plattform_id = pl.platformPostId || null
    t.stand = iso(jetzt())
    delete t.fehler
    delete t.fehlversuche
    saveAndPush(queue, `[skip ci] TikTok: ${e.id} veroeffentlicht`)
    log(`TikTok VEROEFFENTLICHT ${e.id} ${t.url || '(Link folgt)'}`)
    const link = t.url || `https://www.tiktok.com/@${konto?.username || ''}`
    notify(`TikTok live um ${berlin()} Berlin: ${e.slug}\n${link}\n\nJetzt: Kommentare in der ersten Stunde beantworten.`)
  }

  // Wertet die Antwort von POST /posts oder GET /posts/{id} aus.
  function auswerten(e, queue, post, hinweis) {
    const t = block(e)
    const pl = (post.platforms || []).find((p) => p.platform === 'tiktok') || {}
    if (post._id) t.post_id = post._id
    if (post.status === 'failed' || pl.status === 'failed' || pl.status === 'cancelled') {
      throw fest(pl.errorMessage || hinweis || 'TikTok hat den Beitrag abgelehnt')
    }
    if (pl.status === 'published') return veroeffentlicht(e, queue, pl)
    if (t.status !== 'submitted') {
      t.status = 'submitted'
      t.stand = iso(jetzt())
      saveAndPush(queue, `[skip ci] TikTok: ${e.id} bei Zernio angenommen`)
      log(`TikTok: ${e.id} angenommen (${pl.status || post.status || 'in Arbeit'}), Status wird nachgefragt.`)
    }
  }

  function fehlerBehandeln(e, queue, err) {
    const t = block(e)
    const art = err instanceof TikTokFehler ? err.art : 'voruebergehend'
    t.stand = iso(jetzt())
    if (art === 'fest' || (art === 'voruebergehend' && (t.fehlversuche || 0) + 1 >= REGELN.maxFehlversuche)) {
      // Das Fenster wird frei, damit der naechste Nachschuss-Eintrag es nutzen kann.
      delete t.slot
      t.status = 'error'
      t.fehler = err.message
      t.fehler_at = iso(jetzt())
      saveAndPush(queue, `[skip ci] TikTok: ${e.id} fehlgeschlagen`)
      log(`TikTok FEHLER ${e.id}: ${err.message}`)
      notify(`TikTok-Fehler bei ${e.slug}: ${err.message}\nDer Eintrag bleibt stehen, die anderen laufen weiter.`)
      return
    }
    // Zurueck in die Warteschlange. Das Fenster wird freigegeben, damit der
    // naechste Versuch (nach dem Mindestabstand) noch darin liegen kann.
    if (art === 'voruebergehend') t.fehlversuche = (t.fehlversuche || 0) + 1
    if (t.status === 'posting' || t.status === 'ready') {
      t.status = 'ready'
      delete t.slot
    }
    saveAndPush(queue, `[skip ci] TikTok: ${e.id} wird spaeter erneut versucht`)
    log(`TikTok: ${e.id} spaeter erneut (${err.message})`)
    if (art === 'auth') { konto = null; pausieren(err.message) }
  }

  async function posten(e, queue, slot) {
    const t = block(e)
    t.status = 'posting'
    t.gestartet_at = iso(jetzt())
    t.stand = t.gestartet_at
    t.versuch = t.versuch || 1
    if (slot) t.slot = slot
    saveAndPush(queue, `[skip ci] TikTok: ${e.id} wird gepostet`)
    log(`TikTok POST ${e.id} (${slot ? `Nachschuss${t.nr ? ` Nr. ${t.nr}` : ''}` : 'Gleichtakt'})`)
    try {
      const caption = t.caption ?? e.caption ?? ''
      if ([...caption].length > 2200) throw fest(`Caption hat ${[...caption].length} Zeichen, TikTok erlaubt 2.200`)
      const videoQuelle = t.video_url || e.video_url
      if (!videoQuelle) throw fest('Keine Videoquelle im Eintrag')
      const video = await umziehen(videoQuelle, 'video/mp4', `${e.slug}.mp4`, 500_000)
      let cover = null
      const coverQuelle = t.cover_url || e.cover_url
      if (coverQuelle) {
        try {
          cover = await umziehen(coverQuelle, 'image/jpeg', `${e.slug}-cover.jpg`, 10_000)
        } catch (err) {
          if (err.art === 'auth') throw err
          log(`TikTok: Cover fuer ${e.id} nicht nutzbar (${err.message}), TikTok nimmt ein Standbild.`)
        }
      }
      const r = await zernio('POST', '/posts', {
        content: caption,
        mediaItems: [{ type: 'video', url: video }],
        platforms: [{ platform: 'tiktok', accountId: konto._id }],
        tiktokSettings: {
          privacy_level: 'PUBLIC_TO_EVERYONE',
          allow_comment: true,
          allow_duet: true,
          allow_stitch: true,
          // TikTok verlangt diese beiden Zustimmungen je Beitrag. Sie stehen
          // fuer Jans Freigabe vom 26.09.2026, jeden "ready"-Eintrag dieser
          // Queue automatisch zu veroeffentlichen.
          content_preview_confirmed: true,
          express_consent_given: true,
          // Alles hier ist KI-erzeugt; Kennzeichnung wie auf Instagram.
          video_made_with_ai: true,
          commercialContentType: 'none',
          ...(cover ? { video_cover_image_url: cover } : {}),
        },
        publishNow: true,
        metadata: { queue_id: e.id },
      }, { 'Idempotency-Key': `glanwick-tt-${e.id}-${t.versuch}` }, 600_000)

      if ([200, 201, 207].includes(r.status) && r.json.post) return auswerten(e, queue, r.json.post, r.json.error)
      if (r.status === 409 && r.json.code === 'idempotency_conflict') throw voruebergehend('Zernio verarbeitet den ersten Aufruf noch')
      if (r.status === 409 && r.json.details?.existingPostId) {
        // Gleicher Inhalt ist bei Zernio schon unterwegs: nicht neu posten,
        // sondern den vorhandenen Beitrag verfolgen.
        t.post_id = r.json.details.existingPostId
        t.status = 'submitted'
        t.stand = iso(jetzt())
        saveAndPush(queue, `[skip ci] TikTok: ${e.id} war schon angenommen`)
        return
      }
      if (r.status === 401) throw auth('Zernio lehnt den API-Schluessel ab (401).')
      if (r.status === 403 && r.json.code === 'ACCOUNT_DISCONNECTED') throw auth('Das TikTok-Konto muss in Zernio neu verbunden werden.')
      if (r.status === 429 || r.status >= 500) throw voruebergehend(`Zernio HTTP ${r.status} ${r.json.error || ''}`.trim())
      throw fest(`Zernio HTTP ${r.status}: ${r.json.error || 'ohne Begruendung'}`)
    } catch (err) {
      fehlerBehandeln(e, queue, err)
    }
  }

  async function nachfassen(e, queue) {
    const t = block(e)
    let r
    try {
      r = await zernio('GET', `/posts/${encodeURIComponent(t.post_id)}`)
    } catch (err) {
      log(`TikTok: Status von ${e.id} nicht abrufbar (${err.message})`)
      return
    }
    if (r.status !== 200 || !r.json.post) {
      log(`TikTok: Status von ${e.id} HTTP ${r.status}`)
      return
    }
    if (t.status === 'published') {
      const pl = (r.json.post.platforms || []).find((p) => p.platform === 'tiktok') || {}
      if (pl.platformPostUrl) {
        t.url = pl.platformPostUrl
        t.plattform_id = pl.platformPostId || t.plattform_id || null
        saveAndPush(queue, `[skip ci] TikTok: Link fuer ${e.id}`)
        log(`TikTok: Link fuer ${e.id}: ${t.url}`)
      }
      return
    }
    try {
      auswerten(e, queue, r.json.post)
      if (block(e).status === 'submitted' && jetzt() - ms(t.gestartet_at) > REGELN.submittedMaxMin * 60_000) {
        throw fest(`haengt seit ${REGELN.submittedMaxMin / 60} Stunden bei Zernio`)
      }
    } catch (err) {
      fehlerBehandeln(e, queue, err)
    }
  }

  let ohneSchluesselGemeldet = false

  return async function takt(queue) {
    if (!schluessel) {
      if (!ohneSchluesselGemeldet) { log('TikTok: ZERNIO_API_KEY fehlt, der TikTok-Teil ruht.'); ohneSchluesselGemeldet = true }
      return
    }
    const jetztMs = jetzt()

    // 1. Haengengebliebenes "posting" freigeben. Der Idempotenz-Schluessel
    //    bleibt gleich: Hatte Zernio den Beitrag schon angelegt, kommt beim
    //    naechsten Versuch genau dieser zurueck, kein zweiter.
    for (const e of queue.entries) {
      const t = block(e)
      if (t?.status === 'posting' && jetztMs - ms(t.gestartet_at) > REGELN.haengtMin * 60_000) {
        t.status = 'ready'
        t.stand = iso(jetztMs)
        saveAndPush(queue, `[skip ci] TikTok: ${e.id} zurueck auf ready (haengengeblieben)`)
        log(`TikTok: ${e.id} hing, wieder auf ready.`)
      }
    }

    // 2. Angenommene Beitraege nachfragen, fehlende Links nachtragen.
    for (const e of queue.entries) {
      const t = block(e)
      if (!t?.post_id) continue
      const offen = t.status === 'submitted'
      const ohneLink = t.status === 'published' && !t.url && jetztMs - ms(t.published_at) < REGELN.urlSucheMaxMin * 60_000
      if (!offen && !ohneLink) continue
      const abstand = offen ? 60_000 : 5 * 60_000
      if (jetztMs - (zuletztNachgefasst.get(t.post_id) || 0) < abstand) continue
      zuletztNachgefasst.set(t.post_id, jetztMs)
      await nachfassen(e, queue)
    }

    if (jetztMs < pausiertBis) return
    // Mit Konto alle 30 Minuten gegenpruefen, ohne Konto alle 5 Minuten, damit
    // eine frische Verbindung schnell greift, ohne Zernio im Takt zu fragen.
    if (jetztMs - kontoGeprueft > (konto ? 30 : 5) * 60_000) {
      try { await kontoHolen() } catch (err) { log(`TikTok: Kontenabfrage fehlgeschlagen (${err.message})`) }
    }
    if (!konto) return

    // 3. Mindestabstand zwischen zwei TikTok-Posts.
    if (jetztMs - letzterStart(queue) < REGELN.abstandMin * 60_000) return

    // 4. Doppelte Slugs aussortieren, dann Gleichtakt vor Nachschuss.
    const { gleichtakt, nachschuss } = kandidaten(queue, jetztMs)
    for (const e of [...gleichtakt, ...nachschuss]) {
      if (!schonAufTikTok(queue, e)) continue
      const t = block(e)
      t.status = 'uebersprungen'
      t.fehler = 'Slug ist schon auf TikTok'
      t.stand = iso(jetztMs)
      saveAndPush(queue, `[skip ci] TikTok: ${e.id} uebersprungen (Slug schon auf TikTok)`)
      log(`TikTok: ${e.id} uebersprungen, ${e.slug} ist schon auf TikTok.`)
    }
    const nochGleichtakt = gleichtakt.filter((e) => block(e).status === 'ready')
    if (nochGleichtakt.length) return posten(nochGleichtakt[0], queue, null)

    const fenster = offenesFenster(new Date(jetztMs), zweiAmTag(queue) ? REGELN.zeitenZwei : REGELN.zeitenEiner)
    if (!fenster) return
    const slot = fenster.toISOString()
    if (queue.entries.some((e) => block(e)?.slot === slot)) return
    const naechster = nachschuss.find((e) => block(e).status === 'ready')
    if (naechster) return posten(naechster, queue, slot)
  }
}
