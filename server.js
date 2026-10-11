"use strict";
// PLUVIA SENSE — zero-dependency backend (Node >= 18): accounts, sensors, LoRaWAN uplinks, risk engine, warnings, offline-ready front end.
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const PORT = +process.env.PORT || 3000, DATA = process.env.DATA_DIR || path.join(__dirname, "data"), PUB = path.join(__dirname, "public");
const OPS = process.env.OPS_TOKEN || crypto.randomBytes(6).toString("hex");      // administrator access code (also accepted as an API token)
const DEV = process.env.DEVICE_KEY || crypto.randomBytes(8).toString("hex");     // key sent by sensors / LoRaWAN network server
const DEMO = process.env.DEMO_MODE !== "0";                                      // DEMO_MODE=0: never simulate sites that have no live device
const OFFICIAL = (process.env.OFFICIAL_DOMAINS || "gov.tn").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
let VERSION = "2.0.0"; try { VERSION = require("./package.json").version; } catch (e) {}
const RISK = ["Normal", "Watch", "Warning", "Critical"], TYPES = ["Flooding", "Blocked drain", "Road cut off", "Accident", "Other"];
const STAT = ["New", "Verified", "Acknowledged", "Dispatched", "Resolved"], BOX = { lat: [36.5, 37.15], lon: [9.8, 10.75] };
const ORGS = ["Protection Civile", "Municipality", "ONAS", "Ministry of Equipment", "Governorate / Ministry of Interior", "Other public authority"];
fs.mkdirSync(path.join(DATA, "media"), { recursive: true });
const DBF = path.join(DATA, "db.json"); let db = {};
try { db = JSON.parse(fs.readFileSync(DBF, "utf8")); } catch (e) {}
for (const k of ["reports", "alerts", "subs", "outbox", "eps", "users", "events"]) db[k] = db[k] || [];
for (const k of ["sent", "sites", "calib", "series"]) db[k] = db[k] || {};
db.secret = process.env.SESSION_SECRET || db.secret || crypto.randomBytes(32).toString("hex");
let tm; const save = () => { clearTimeout(tm); tm = setTimeout(() => fs.writeFile(DBF, JSON.stringify(db), () => {}), 400); };
const media = n => path.join(DATA, "media", n);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v)), esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const dist = (a, b) => { const r = Math.PI / 180, x = (b.lon - a.lon) * r * Math.cos((a.lat + b.lat) * r / 2), y = (b.lat - a.lat) * r; return Math.hypot(x, y) * 6371e3; };
const eq = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const logEv = (node, kind, text, by) => { db.events.unshift({ t: Date.now(), node, kind, text, by: by || null }); db.events.length = Math.min(db.events.length, 1500); save(); };
// ---- Accounts and sessions (HMAC-signed tokens, scrypt password hashes)
const b64u = s => Buffer.from(s).toString("base64url");
const sign = (pl, ttl) => { const b = b64u(JSON.stringify({ ...pl, exp: Date.now() + ttl })); return b + "." + crypto.createHmac("sha256", db.secret).update(b).digest("base64url"); };
const verify = tok => { const [b, s] = String(tok || "").split("."); if (!b || !s) return null; if (!eq(crypto.createHmac("sha256", db.secret).update(b).digest("base64url"), s)) return null; try { const p = JSON.parse(Buffer.from(b, "base64url")); return p.exp > Date.now() ? p : null; } catch (e) { return null; } };
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 64).toString("hex");
const TTL = { reporter: 30 * 864e5, decision: 12 * 36e5, admin: 8 * 36e5 };
const pubUser = u => ({ id: u.id, role: u.role, name: u.name, org: u.org || null, status: u.status });
function who(req, u) {
  const raw = (req.headers.authorization || "").replace(/^Bearer\s+/i, "") || req.headers["x-ops-token"] || u.searchParams.get("token") || ""; if (!raw) return null;
  if (eq(raw, OPS)) return { id: "master", role: "admin", name: "Administrator" };
  const p = verify(raw); if (!p) return null;
  if (p.role === "admin") return { id: "admin", role: "admin", name: "Administrator" };
  const usr = db.users.find(x => x.id === p.uid); return usr && usr.status === "active" ? { id: usr.id, role: usr.role, name: usr.name, org: usr.org } : null;
}
// ---- Sites: proposed monitoring points (edit coordinates here, or tune type / threshold / criteria in the Admin tab)
const SITE_TYPES = { road: { label: "Road or open low point", sensing: "Non-contact ultrasonic", why: "Simple installation" }, drain: { label: "Storm drain or catch basin", sensing: "Pressure based where feasible", why: "Can monitor within the drainage structure" }, critical: { label: "Critical infrastructure", sensing: "Redundant sensing where justified", why: "Lower tolerance for missed events" }, community: { label: "Community point", sensing: "Rain gauge plus observations", why: "Useful local context" } };
const CRIT = [["history", "Previous flood history", 5, 1], ["elevation", "Low elevation or local depression", 4, 1], ["drainage", "Drainage vulnerability", 4, 1], ["population", "Population exposure", 4, 1], ["infra", "Critical infrastructure", 4, 1], ["road", "Road importance", 3.5, 1], ["comms", "Communication feasibility", 3, 0], ["access", "Maintenance access", 3, 0]];
const NODES = [["Lac 2 outfall", 36.835, 10.27, 90, "drain"], ["Ennasr / Ariana", 36.865, 10.16, 100, "road"], ["Manouba centre", 36.81, 10.095, 110, "road"], ["Sijoumi basin", 36.79, 10.136, 120, "road"],
  ["Ettadhamen", 36.835, 10.1, 100, "community"], ["Ben Arous", 36.753, 10.23, 110, "road"], ["Mégrine", 36.77, 10.233, 90, "road"], ["Oued Méliane", 36.72, 10.29, 130, "drain"]]
  .map(([name, lat, lon, thr, type], i) => ({ id: "N" + (i + 1), name, lat, lon, thr, thr0: thr, type0: type, L: 14 + i, real: 0, f3: 0, boost: 0, rain: 0, devRain: 0, rate: 0, eta: Infinity, risk: 0, sim: true, lastReal: 0, lastT: 0, frame: false, hourly: [], la: {}, q: { gaps: 0 }, mode: "normal", conf: .5, confWhy: [], vuln: .5, hy: 0, sc: 0, maint: false, stormy: i > 0 && i < 5 }));
const site = n => { const o = db.sites[n.id] || {}; return { type: o.type || n.type0, thr: o.thr || n.thr0, criteria: o.criteria || null, maintenance: !!o.maintenance }; };
const score = (cr, onlyVuln) => { let a = 0, b = 0; CRIT.forEach(([k, , w, v]) => { if (onlyVuln && !v) return; a += w * (cr && cr[k] != null ? cr[k] : 2.5); b += w * 5; }); return a / b; };
const MODES = { normal: { interval: 300, label: "Normal: low-frequency sampling" }, heavy_rain: { interval: 60, label: "Heavy rain: increased sampling" }, emergency: { interval: 10, label: "Emergency: rapid transmission" }, maintenance: { interval: 600, label: "Maintenance: diagnostics and calibration" } };
const LIM = { levelMin: 0, levelMax: 500, rateMax: 20, calibDays: 180 };
let storm = false, wxOK = null, wxT = 0, fakeFc = null, EPS = [], lorawanHits = [];
// ---- Decision support
const acts = (k, n) => k >= 3 ? [`Dispatch Protection Civile pumping and rescue units to ${n.name}`, "Close the nearest road or underpass and divert traffic", "Send an SMS / push alert to residents within 500 m", "Activate pumping stations and open retention basins", "Alert ONAS and the municipal crisis cell"]
  : k == 2 ? ["Pre-position pump trucks within 15 minutes", "Clear grates and culverts upstream", "Brief municipal crews and traffic police", "Raise sensor sampling to 1-minute readings"]
  : ["Keep monitoring and review the 3-hour forecast", "Inspect drains before the rain peak"];
const near = p => NODES.reduce((a, n) => dist(n, p) < dist(a, p) ? n : a);
function cred(r) {
  let s = 10; const w = ["Report received"], n = near(r), d = dist(n, r);
  if (r.np || r.vext || r.video) { s += 25; w.push("Live photo or video evidence +25"); } else w.push("No live photo or video attached");
  if (r.vext || r.video) { s += 10; w.push("Video +10"); }
  if (r.src === "gps" && r.acc < 50) { s += 20; w.push("GPS fix under 50 m +20"); } else if (r.src === "gps") { s += 10; w.push("GPS fix +10"); } else { s += 5; w.push(r.src === "search" ? "Location chosen by place name +5" : "Pin placed by hand +5"); }
  if (r.uid) { s += 5; w.push("Signed-in observer +5"); }
  if (d < 2500 && r.type !== "Accident") { if (n.risk >= 2) { s += 25; w.push(`${n.name} sensor at ${RISK[n.risk]} +25`); } else if (n.risk == 1) { s += 10; w.push(`${n.name} sensor at Watch +10`); } }
  const o = db.reports.filter(x => x.id !== r.id && Date.now() - x.t < 36e5 && dist(x, r) < 400).length; if (o) { s += 15; w.push(`${o} other report(s) within 400 m +15`); }
  if (n.rain > .1 && d < 5000) { s += 5; w.push("Rain confirmed by weather data +5"); }
  return { s: Math.min(100, s), w };
}
function advise(r) {
  const n = near(r), d = dist(n, r), a = [];
  if (r.type === "Accident") return ["Call SAMU 190 / Police 197 and dispatch the nearest unit", "Divert traffic and warn drivers of standing water on the route"];
  if (d < 2500 && n.risk >= 2) a.push(`Nearest sensor (${n.name}, ${(d / 1000).toFixed(1)} km) is at ${RISK[n.risk]}${isFinite(n.eta) ? `, overflow in about ${Math.round(n.eta)} min` : ""}`);
  return a.concat(acts(Math.max(n.risk, r.sev >= 3 ? 3 : r.sev == 2 ? 2 : 1), n));
}
const svgFrame = n => { const h = Math.round(Math.min(1, n.L / n.thr) * 120), t = (y, s) => `<text x="8" y="${y}" fill="#fff" font-size="12" font-family="sans-serif">${esc(s)}</text>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#2b3a42"/><rect y="${180 - h}" width="320" height="${h}" fill="#3A86B8" opacity=".85"/>${t(16, `CAM ${n.id} · ${n.name}`)}${t(32, `level ${Math.round(n.L)} cm · rain ${Math.round(n.rain)} mm/h`)}${t(172, n.sim ? "simulated frame" : "sensor frame")}</svg>`); };
const EVENT_TEXT = { water_rising: "Camera detected rising water", suspicious: "Camera detected something suspicious near the water", blocked_drain: "Camera detected a blocked drain or debris" };
function forecastSvg(n) {
  const H = nodeHourly(n).filter(x => x.t > Date.now()).slice(0, 12), pk = Math.max(0, ...H.map(x => x.mm)), mx = Math.max(8, pk);
  const bars = H.map((x, i) => `<rect x="${12 + i * 25}" y="${150 - x.mm / mx * 110}" width="20" height="${x.mm / mx * 110}" fill="${x.mm >= HEAVY ? "#D93036" : "#3A86B8"}"/>`).join("");
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#EEF4F8"/>${bars}<text x="8" y="16" fill="#0B3669" font-size="12" font-family="sans-serif">Forecast rain, next 12 h · ${esc(n.name)}</text><text x="8" y="172" fill="#587087" font-size="11" font-family="sans-serif">peak ${pk.toFixed(1)} mm/h</text></svg>`);
}
function raise(n, k, trigger = "sensor", reason = "Water level above the alert threshold", frameFile, opsOnly) {
  const id = "A" + Date.now().toString(36) + crypto.randomBytes(2).toString("hex"); let img = svgFrame(n);
  if (trigger === "forecast") img = forecastSvg(n);
  else if (frameFile || (n.frame && !n.sim)) { try { fs.copyFileSync(media(frameFile || `node-${n.id}.jpg`), media(`alert-${id}.jpg`)); img = `/api/media/alert-${id}.jpg`; } catch (e) {} }
  const a = { id, kind: "alert", node: n.id, lat: n.lat, lon: n.lon, risk: k, t: Date.now(), status: "New", img, acts: acts(k, n), trigger, reason };
  db.alerts.unshift(a); db.alerts.length = Math.min(db.alerts.length, 200); logEv(n.id, "alert", `${RISK[k]}: ${reason}`);
  if (!opsOnly) push("alert", { id, node: n.id, risk: k, trigger, reason }); push("alertfull", a, true); return a;
}
const can = (n, k, ms, now) => !n.la[k] || now - n.la[k] > ms;
function suspicious(n, now) {
  if (n.maint) return;
  if (n.rate >= (n.sim ? .9 : 2) && n.L / n.thr >= .2 && can(n, "rapid", 6e5, now)) { n.la.rapid = now; n.q.verify = !n.sim; raise(n, Math.max(2, n.risk), "rapid", `Water level rising fast (${n.rate.toFixed(1)} cm per minute)`); }
  else if (n.rate >= (n.sim ? .5 : 1) && n.rain < 1 && n.L > 25 && can(n, "norain", 6e5, now)) { n.la.norain = now; n.q.verify = !n.sim; raise(n, 2, "norain", "Water rising without rainfall: check for a blocked drain, a burst pipe or an upstream release"); }
}
// ---- Data quality: range, rate, missing data, timeout, battery, signal, calibration, manual verification -> sensor confidence (0..1)
function confidence(n, now) {
  if (n.sim) return DEMO ? { c: .5, why: ["Simulated data: no live device reporting"] } : { c: 0, why: ["No data from this site yet"] };
  const q = n.q, why = [], iv = MODES[n.mode].interval * 1000, age = now - n.lastReal; let c = 1;
  if (age > Math.max(600e3, 10 * iv)) { c -= .6; why.push("Communication timeout"); } else if (age > 3 * iv) { c -= .25; why.push(`Missing data: last reading ${Math.round(age / 6e4)} min ago`); }
  if (q.rangeAt && now - q.rangeAt < 6e5) { c -= .4; why.push("Range check failed recently"); }
  if (q.rateAt && now - q.rateAt < 6e5) { c -= .25; why.push("Implausible rate of rise recently"); }
  if (q.gaps > 0 && q.gapAt && now - q.gapAt < 36e5) { c -= .1; why.push(`${q.gaps} missing frame(s) detected`); }
  if (q.battery != null) { if (q.battery < 10) { c -= .2; why.push(`Battery critical (${q.battery}%)`); } else if (q.battery < 20) { c -= .1; why.push(`Battery low (${q.battery}%)`); } }
  if (q.rssi != null && q.rssi < -115) { c -= .1; why.push(`Weak signal (RSSI ${q.rssi} dBm)`); }
  const cal = (db.calib[n.id] || []).slice(-1)[0]; if (!cal || now - cal.t > LIM.calibDays * 864e5) { c -= .1; why.push(cal ? "Calibration overdue" : "No calibration record"); }
  if (q.verify) { c -= .15; why.push("Awaiting manual verification after an unusual event"); }
  return { c: clamp(+c.toFixed(2), 0, 1), why: why.length ? why : ["All data-quality checks passed"] };
}
const pushSeries = (n, t, L, rain) => { const a = db.series[n.id] = db.series[n.id] || []; a.push([t, +(+L).toFixed(1), +(+rain).toFixed(1), Math.round(n.conf * 100)]); if (a.length > 800) a.splice(0, a.length - 800); };
const corroborated = (n, now) => (n.la.cam && now - n.la.cam < 6e5) || db.reports.some(r => now - r.t < 18e5 && r.sev >= 2 && dist(r, n) < 600);
function ingest(n, b) {   // one reading from a device (HTTP or LoRaWAN)
  const now = Date.now(), q = n.q; let L = +b.level_cm;
  if (!isFinite(L) || L < LIM.levelMin || L > LIM.levelMax) { q.rangeAt = now; q.verify = true; logEv(n.id, "quality", `Range check failed (level ${b.level_cm})`); return { code: 422, error: `level_cm must be between ${LIM.levelMin} and ${LIM.levelMax}` }; }
  const cal = (db.calib[n.id] || []).slice(-1)[0]; if (cal && isFinite(cal.offset_cm)) L += cal.offset_cm;
  let ts = b.ts != null ? (isFinite(+b.ts) ? +b.ts : Date.parse(b.ts)) : now; if (!isFinite(ts) || Math.abs(now - ts) > 6 * 36e5 || ts > now + 6e4) ts = now;
  if (b.seq != null) { const s = +b.seq; if (q.seq != null && s <= q.seq && !b.buffered) return { code: 200, dup: true }; if (q.seq != null && s > q.seq + 1 && !b.buffered) { q.gaps += s - q.seq - 1; q.gapAt = now; logEv(n.id, "quality", `${s - q.seq - 1} frame(s) missing before #${s}`); } q.seq = Math.max(q.seq == null ? s : q.seq, s); }
  if (b.battery_pct != null && isFinite(+b.battery_pct)) q.battery = clamp(Math.round(+b.battery_pct), 0, 100);
  if (isFinite(+b.rssi)) q.rssi = +b.rssi; if (isFinite(+b.snr)) q.snr = +b.snr; if (b.fw) q.fw = String(b.fw).slice(0, 20);
  const rain = clamp(+b.rain_mmh || 0, 0, 300);
  if (b.buffered && ts < n.lastT) { pushSeries(n, ts, L, rain); return { code: 200, buffered: true }; }   // late frame from the device buffer: history only
  const dtMin = Math.max((ts - (n.lastT || ts - 6e4)) / 6e4, .05), rate = n.lastT ? (L - n.L) / dtMin : 0;
  if (n.lastT && Math.abs(rate) > LIM.rateMax && now - n.lastReal < 6e5) {   // rate check: hold an implausible jump until a second reading confirms it
    if (q.pending != null && Math.abs(L - q.pending) <= Math.max(10, .3 * q.pending)) q.pending = null;
    else { q.pending = L; q.rateAt = now; q.verify = true; logEv(n.id, "quality", `Rate check: jump of ${rate.toFixed(0)} cm/min held for confirmation`); return { code: 202, held: true, mode: n.mode, next_interval_s: MODES[n.mode].interval }; }
  }
  q.pending = null; n.rate = rate; n.L = L; n.devRain = rain; n.lastReal = now; n.lastT = ts; n.sim = false; q.missLogged = false;
  pushSeries(n, ts, L, rain);
  const f = jpg(b.frame, 2e6); if (f) { fs.writeFileSync(media(`node-${n.id}.jpg`), f); n.frame = true; }
  if (EVENT_TEXT[b.event] && can(n, "cam", 3e5, now)) { n.la.cam = now; n.q.verify = true; raise(n, Math.max(2, n.risk), "camera", EVENT_TEXT[b.event], f ? `node-${n.id}.jpg` : undefined); }
  if (q.battery != null && q.battery < 15 && can(n, "batt", 864e5, now)) { n.la.batt = now; raise(n, 1, "battery", `Battery low (${q.battery}%): schedule maintenance`, undefined, true); }
  const qc = confidence(n, now); n.conf = qc.c; n.confWhy = qc.why;
  return { code: 200, ok: true, mode: n.mode, next_interval_s: MODES[n.mode].interval, confidence: n.conf };
}
const out = ({ code, ...rest }) => rest;   // never expose the internal status code in the JSON body
// ---- Risk engine (every 2 s): level, rain intensity, rate of rise, site threshold, vulnerability, confidence; hysteresis on the way down
const HYST = 5;
function tick() {
  const now = Date.now();
  NODES.forEach(n => {
    const cfg = site(n); n.thr = cfg.thr; n.type = cfg.type; n.maint = cfg.maintenance; n.vuln = score(cfg.criteria, true);
    const live = n.lastReal && now - n.lastReal < Math.max(600e3, 10 * MODES[n.mode].interval * 1000);
    n.sim = !live;
    if (n.sim && DEMO) {
      n.boost = storm && n.stormy ? Math.min(50, n.boost + 4) : Math.max(0, n.boost - 5); n.rain = n.real + n.boost; const pL = n.L;
      n.L = clamp(n.L + n.rain * .035 - .2 - n.L * .004 + (Math.random() - .5) * .1, 8, n.thr * 1.5); n.rate = n.L - pL;
      if (++n.sc % 15 === 0) pushSeries(n, now, n.L, n.rain);
    } else if (n.sim) { n.rain = n.real; n.rate = 0; } else { n.rain = n.devRain; if (now - n.lastReal > 2 * MODES[n.mode].interval * 1000) n.rate = 0; }   // a silent device must not keep an old rate of rise
    if (n.lastReal && n.sim && can(n, "comms", 216e5, now)) { n.la.comms = now; logEv(n.id, "quality", "Communication timeout"); raise(n, 1, "comms", "Communication timeout: no data received. Check power, gateway and coverage.", undefined, true); }
    if (n.lastReal && !n.sim && now - n.lastReal > 3 * MODES[n.mode].interval * 1000 && !n.q.missLogged) { n.q.missLogged = true; logEv(n.id, "quality", "Missing data: readings are late"); }
    const qc = confidence(n, now); n.conf = qc.c; n.confWhy = qc.why;
    const f = 1 + .25 * (2 * n.vuln - 1);   // more vulnerable sites warn earlier
    n.eta = n.rate > .05 ? (n.thr - n.L) / n.rate : Infinity;
    const lvl = m => { const r = n.L / n.thr * f * m, ra = n.rain * f * m; let k = 0;
      if (r >= .4 || ra >= 5 || n.f3 * f * m >= 10) k = 1; if (r >= .65 || ra >= 15 || (n.rate * m >= 1 && r >= .3)) k = 2; if (r >= .9 || (n.eta / m < 20 && ra >= 20)) k = 3; return k; };
    let kUp = lvl(1); n.unverified = false;
    if (kUp >= 3 && n.conf < .5 && !corroborated(n, now)) { kUp = 2; n.unverified = true; }   // a low-confidence sensor alone cannot trigger Critical
    const old = n.risk;
    if (kUp > n.risk) { n.risk = kUp; n.hy = 0; } else if (lvl(1 / .9) < n.risk) { if (++n.hy >= HYST) { n.risk--; n.hy = 0; } } else n.hy = 0;   // hysteresis: step down one level only after sustained improvement
    if (n.risk > old && n.risk >= 2 && !n.maint && !(n.sim && !DEMO)) raise(n, n.risk, "sensor", `Water level at ${Math.round(n.L / n.thr * 100)}% of the site threshold${n.unverified ? " (sensor confidence low: verification needed)" : ""}`);
    suspicious(n, now);
    const m = n.maint ? "maintenance" : n.risk >= 2 && n.conf >= .5 ? "emergency" : (n.rain >= 5 || n.f3 >= 10 || n.risk >= 1) ? "heavy_rain" : "normal";
    if (m !== n.mode) { logEv(n.id, "mode", MODES[m].label); n.mode = m; }
  });
  if (now - (tick.s || 0) > 6e4) { tick.s = now; save(); }
  broadcast();
}
// ---- Weather, forecast and warnings (schools, parents, authorities)
const HEAVY = +process.env.HEAVY_MM_H || 8, MOD = 3;
const TW = { sid: process.env.TWILIO_SID, token: process.env.TWILIO_TOKEN, from: process.env.TWILIO_FROM }, WEBHOOK = process.env.WEBHOOK_URL;
const tf = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Tunis", hour: "2-digit", minute: "2-digit", hour12: false }), hhmm = ms => tf.format(ms);
const fmtDur = ms => { const m = Math.round(ms / 6e4), h = Math.floor(m / 60); return `${h} h${m % 60 ? " " + (m % 60) + " min" : ""}`; };
function nodeHourly(n) {
  if (!fakeFc) return n.hourly;
  const base = n.hourly.length ? n.hourly : Array.from({ length: 36 }, (_, i) => ({ t: Math.ceil(Date.now() / 36e5) * 36e5 + i * 36e5, mm: 0 }));
  return base.map(h => { const ov = Math.min(h.t, fakeFc.start + fakeFc.len) - Math.max(h.t - 36e5, fakeFc.start); return ov >= 18e5 ? { t: h.t, mm: Math.max(h.mm, fakeFc.peak) } : h; });
}
async function loadWx() {
  try {
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${NODES.map(n => n.lat).join()}&longitude=${NODES.map(n => n.lon).join()}&current=precipitation&hourly=precipitation&forecast_hours=36&timezone=GMT`;
    const r = await fetch(u, { signal: AbortSignal.timeout(8000) }); if (!r.ok) throw new Error(r.status); const j = await r.json();
    (Array.isArray(j) ? j : [j]).forEach((x, i) => { const n = NODES[i]; n.real = x.current.precipitation || 0; n.hourly = x.hourly.time.map((t, k) => ({ t: Date.parse(t + "Z"), mm: x.hourly.precipitation[k] || 0 })); });
    wxOK = true; wxT = Date.now();
  } catch (e) { wxOK = false; }
  NODES.forEach(n => { const now = Date.now(); n.f3 = nodeHourly(n).filter(h => h.t > now && h.t <= now + 3 * 36e5).reduce((a, h) => a + h.mm, 0); });
  episodes();
}
function windows(n) {   // Open-Meteo hourly rain at time T covers the hour BEFORE T
  const H = nodeHourly(n), out = []; let i = 0;
  while (i < H.length) {
    if (H[i].mm >= MOD) { let j = i, peak = 0, sum = 0; while (j < H.length && H[j].mm >= MOD) { peak = Math.max(peak, H[j].mm); sum += H[j].mm; j++; }
      if (peak >= HEAVY || sum >= 25) out.push({ start: H[i].t - 36e5, end: H[j - 1].t, peak: +peak.toFixed(1), sum: +sum.toFixed(1) }); i = j; } else i++;
  }
  return out;
}
const MSG = {
  en: { hd: { early: "Heads-up", soon: "WARNING: in about 1 hour", clear: "ALL CLEAR", wait: "Roads still closed" },
    body: a => `Intense rainfall expected from ${a.from} to ${a.to} (up to ${a.peak} mm/h) near ${a.area}. Roads may be cut off until about ${a.reopen} (about ${a.dur}). Do not risk the roads.`,
    clr: a => `The intense rainfall near ${a.area} has ended and roads are reopening.`,
    adv: { school: "Keep pupils inside the school until the all-clear message. Do not let children leave during the event.", parent: "Do not travel to pick up your child during the event. Your child stays safe at school until the all-clear.", authority: "Pre-position pumps and crews, prepare road closures and inform schools and residents." },
    advC: { school: "You may organise pupils' return, following local instructions.", parent: "Roads are reopening. Follow your school's instructions to collect your child.", authority: "Check road status and stand down teams after inspection." },
    pub: "Stay safe and do not risk the roads. Pupils stay at school until the all-clear." },
  fr: { hd: { early: "Information préalable", soon: "ALERTE : dans environ 1 heure", clear: "FIN D'ALERTE", wait: "Routes encore coupées" },
    body: a => `Fortes pluies attendues de ${a.from} à ${a.to} (jusqu'à ${a.peak} mm/h) près de ${a.area}. Les routes peuvent être coupées jusqu'à environ ${a.reopen} (environ ${a.dur}). Ne prenez pas de risque sur la route.`,
    clr: a => `Les fortes pluies près de ${a.area} sont terminées, les routes rouvrent progressivement.`,
    adv: { school: "Gardez les élèves à l'école jusqu'au message de fin d'alerte. Ne laissez pas partir les enfants pendant l'épisode.", parent: "Ne vous déplacez pas pour récupérer votre enfant pendant l'épisode. Il reste en sécurité à l'école jusqu'à la fin d'alerte.", authority: "Pré-positionnez pompes et équipes, préparez les fermetures de routes et informez écoles et habitants." },
    advC: { school: "Vous pouvez organiser le retour des élèves selon les consignes locales.", parent: "Les routes rouvrent. Suivez les consignes de l'école pour récupérer votre enfant.", authority: "Vérifiez l'état des routes et levez le dispositif après inspection." },
    pub: "Restez en sécurité et ne prenez pas de risque sur la route. Les élèves restent à l'école jusqu'à la fin d'alerte." },
  ar: { hd: { early: "تنبيه مسبق", soon: "تحذير: بعد حوالي ساعة", clear: "انتهى الخطر", wait: "الطرق ما زالت مقطوعة" },
    body: a => `أمطار غزيرة متوقعة من ${a.from} إلى ${a.to} (حتى ${a.peak} مم/س) قرب ${a.area}. قد تُقطع الطرق إلى حدود ${a.reopen} (حوالي ${a.dur}). لا تخاطروا بالطرقات.`,
    clr: a => `توقفت الأمطار الغزيرة قرب ${a.area} وبدأت الطرق تُفتح.`,
    adv: { school: "أبقوا التلاميذ داخل المدرسة إلى حين رسالة انتهاء الخطر ولا تسمحوا بالمغادرة أثناء الحدث.", parent: "لا تتنقلوا لاصطحاب أبنائكم أثناء الحدث. أبناؤكم في أمان داخل المدرسة إلى حين انتهاء الخطر.", authority: "جهّزوا المضخات وفرق التدخل وحضّروا غلق الطرق وأعلموا المدارس والسكان." },
    advC: { school: "يمكنكم تنظيم عودة التلاميذ وفق التعليمات المحلية.", parent: "بدأت الطرق تُفتح. اتبعوا تعليمات المدرسة لاصطحاب أبنائكم.", authority: "راجعوا حالة الطرق وأوقفوا الفرق بعد المعاينة." },
    pub: "حافظوا على سلامتكم ولا تخاطروا بالطرقات. يبقى التلاميذ في المدرسة إلى حين انتهاء الخطر." } };
const vars = e => ({ from: hhmm(e.start), to: hhmm(e.end), peak: e.peak, reopen: hhmm(e.reopen), dur: fmtDur(e.reopen - e.start), area: e.area });
const joinAreas = L => { L = [...new Set(L)]; return L.length > 3 ? L.slice(0, 3).join(", ") + ` +${L.length - 3}` : L.join(", "); };
const mask = s => s.phone ? "•••" + s.phone.slice(-3) : s.email ? s.email.replace(/^(.).*(@.*)$/, "$1***$2") : "in-app only";
async function deliver(s, text, stage, a) {
  const out = [];
  try {
    if (s.phone && TW.sid) { const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TW.sid}/Messages.json`, { method: "POST", headers: { authorization: "Basic " + Buffer.from(TW.sid + ":" + TW.token).toString("base64"), "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ To: s.phone, From: TW.from, Body: text }), signal: AbortSignal.timeout(10000) }); out.push(r.ok ? "SMS sent" : "SMS failed " + r.status); }
    if (WEBHOOK) { const r = await fetch(WEBHOOK, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: { phone: s.phone, email: s.email, name: s.name }, role: s.role, lang: s.lang, stage, area: a.area, text }), signal: AbortSignal.timeout(10000) }); out.push(r.ok ? "webhook sent" : "webhook failed " + r.status); }
  } catch (e) { out.push("failed: " + e.message); }
  return out.length ? out.join(", ") : "not sent: no SMS provider configured";
}
async function send(s, stage, a) {
  const M = MSG[s.lang] || MSG.en, text = `PLUVIA SENSE · ${M.hd[stage]}\n${stage === "clear" ? M.clr(a) : M.body(a)}\n${(stage === "clear" ? M.advC : M.adv)[s.role]}`;
  const o = { id: crypto.randomBytes(4).toString("hex"), t: Date.now(), stage, role: s.role, lang: s.lang, area: a.area, to: mask(s), text, status: "queued" };
  db.outbox.unshift(o); db.outbox.length = Math.min(db.outbox.length, 300); save();
  o.status = await deliver(s, text, stage, a); save();
}
function announce(ep, stage) {
  const k = `${ep.key}:${stage}`; if (db.sent[k]) return; db.sent[k] = Date.now();
  if (!db.eps.find(e => e.key === ep.key)) db.eps.unshift({ ...ep, cleared: false });
  const hk = Math.round(ep.start / 36e5), n = NODES.find(x => x.id === ep.node), a = vars(ep), gk = `G:${hk}:${stage}${fakeFc ? ":" + fakeFc.id : ""}`, first = !db.sent[gk];
  if (stage !== "clear") a.areas = joinAreas(EPS.filter(e => Math.round(e.start / 36e5) === hk).map(e => e.area));
  if (first) db.sent[gk] = Date.now();
  if (stage !== "clear" && first) raise(n, ep.peak >= 20 ? 3 : 2, "forecast", `${stage === "soon" ? "Within 1 hour" : "Forecast"}: intense rainfall ${a.from} to ${a.to} (up to ${a.peak} mm/h). Roads may be cut off until about ${a.reopen}.`);
  db.subs.filter(s => s.node === ep.node || (s.node === "all" && stage !== "clear" && first)).forEach(s => send(s, stage, s.node === "all" ? { ...a, area: a.areas } : a)); save();
}
function episodes() {
  const now = Date.now(); EPS = [];
  NODES.forEach(n => windows(n).forEach(w => {
    if (w.end <= now || w.start - now > 24 * 36e5) return;
    const lag = clamp(Math.round(w.peak / 6), 1, 3) * 36e5;
    EPS.push({ ...w, node: n.id, area: n.name, reopen: w.end + lag, key: `${n.id}:${Math.round(w.start / 36e5)}${fakeFc ? ":" + fakeFc.id : ""}`, fake: !!fakeFc });
  }));
  EPS.forEach(e => announce(e, e.start - now > 36e5 ? "early" : "soon"));
  db.eps.forEach(e => { const n = NODES.find(x => x.id === e.node); if (!e.cleared && now >= e.reopen && n && n.risk < 2) { e.cleared = true; announce(e, "clear"); } });   // all-clear only when roads are due to reopen AND sensors are calm
  for (const k in db.sent) if (now - db.sent[k] > 3 * 864e5) delete db.sent[k];
  db.eps = db.eps.filter(e => now - e.reopen < 864e5).slice(0, 50);
}
function forecastView() { const now = Date.now(), m = new Map(); NODES.forEach(n => nodeHourly(n).forEach(h => { if (h.t > now) m.set(h.t, Math.max(m.get(h.t) || 0, h.mm)); })); return [...m].sort((a, b) => a[0] - b[0]).slice(0, 12).map(([t, mm]) => ({ t, mm: +mm.toFixed(1) })); }
function warnView() {
  const now = Date.now(), L = EPS.map(e => ({ ...e, ph: e.start - now > 36e5 ? "early" : "soon" }));
  db.eps.forEach(e => { if (!e.cleared && now >= e.end && !L.find(x => x.key === e.key)) L.push({ ...e, ph: "wait" }); });
  const g = new Map();
  L.forEach(e => { const k = e.ph + Math.round(e.start / 36e5); if (!g.has(k)) g.set(k, { e, areas: [] }); g.get(k).areas.push(e.area); });
  return [...g.values()].map(({ e, areas }) => { const a = { ...vars(e), area: joinAreas(areas) }; return { area: a.area, from: a.from, to: a.to, reopen: a.reopen, peak: e.peak, ph: e.ph, tx: Object.fromEntries(Object.keys(MSG).map(l => [l, `${MSG[l].hd[e.ph]}: ${MSG[l].body(a)} ${MSG[l].pub}`])) }; });
}
// ---- Report triage
const INT = ["", "Low", "Moderate", "High", "Critical"];
function intensity(r) { const n = near(r), d = dist(n, r), o = db.reports.filter(x => x.id !== r.id && Date.now() - x.t < 36e5 && dist(x, r) < 400).length; let l = r.sev; if ((d < 2500 && n.risk >= 2) || o >= 2) l++; if (n.risk >= 3 && d < 2500 && r.sev >= 2) l = 4; l = clamp(l, 1, 4); return { l, label: INT[l] }; }
function headline(r) { if (r.type === "Accident") return "Dispatch SAMU 190 / Police 197 to the location"; const l = intensity(r).l; return acts(l >= 3 ? 3 : l, near(r))[0]; }
const full = r => { const c = cred(r); return { id: r.id, t: r.t, lat: r.lat, lon: r.lon, type: r.type, sev: r.sev, status: r.status, src: r.src, acc: r.acc, desc: r.desc, by: r.by || null, photos: r.np, video: !!(r.video || r.vext), vext: r.vext || null, noMedia: !!r.noMedia, score: c.s, why: c.w, advice: advise(r), intensity: intensity(r), decision: headline(r) }; };
// ---- Views and real-time push (Server-Sent Events)
const nodePub = n => ({ id: n.id, name: n.name, lat: n.lat, lon: n.lon, thr: n.thr, L: +n.L.toFixed(1), rain: +n.rain.toFixed(1), f3: +n.f3.toFixed(1), eta: isFinite(n.eta) ? Math.round(n.eta) : null, risk: n.risk, sim: n.sim });
function nodeFull(n) {
  const cfg = site(n), st = SITE_TYPES[n.type] || SITE_TYPES.road, cal = (db.calib[n.id] || []).slice(-1)[0], now = Date.now();
  return { ...nodePub(n), type: n.type, typeLabel: st.label, sensing: st.sensing, why: st.why, vuln: +n.vuln.toFixed(2), priority: Math.round(score(cfg.criteria) * 100), surveyed: !!cfg.criteria, criteria: cfg.criteria, conf: n.conf, confWhy: n.confWhy,
    rate: +n.rate.toFixed(2), mode: n.mode, modeLabel: MODES[n.mode].label, interval: MODES[n.mode].interval, battery: n.q.battery ?? null, rssi: n.q.rssi ?? null, snr: n.q.snr ?? null, fw: n.q.fw || null,
    lastSeen: n.lastReal || null, maint: n.maint, verify: !!n.q.verify, unverified: !!n.unverified, calibAt: cal ? cal.t : null, calibDue: !cal || now - cal.t > LIM.calibDays * 864e5, th: { watch: Math.round(n.thr * .4), warning: Math.round(n.thr * .65), critical: Math.round(n.thr * .9) } };
}
function view(me) {
  const ops = !!me && (me.role === "decision" || me.role === "admin");
  return { t: Date.now(), v: VERSION, demo: DEMO, storm, wx: wxOK, wxT, fake: !!fakeFc, ops, me: me ? { id: me.id, role: me.role, name: me.name, org: me.org || null } : null, pending: me && me.role === "admin" ? db.users.filter(u => u.status === "pending").length : 0,
    forecast: forecastView(), warnings: warnView(), outbox: ops ? db.outbox.slice(0, 30) : [], subs: ops ? db.subs.length : 0,
    nodes: NODES.map(n => ops ? nodeFull(n) : nodePub(n)),
    reports: db.reports.slice(0, 100).filter(r => ops || r.status !== "Resolved").map(r => ops ? full(r) : { id: r.id, t: r.t, lat: r.lat, lon: r.lon, type: r.type, sev: r.sev, status: r.status }),
    alerts: ops ? db.alerts.slice(0, 50) : [] };
}
const clients = new Set();
function push(ev, data, opsOnly) { const s = `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of clients) if (!opsOnly || (c.me && (c.me.role === "decision" || c.me.role === "admin"))) c.res.write(s); }
function broadcast() { if (!clients.size) return; const cache = {}; for (const c of clients) { const k = c.me ? c.me.role : "pub"; cache[k] = cache[k] || JSON.stringify(view(c.me)); c.res.write(`event: state\ndata: ${cache[k]}\n\n`); } }
// ---- Static front end + offline support (service worker, manifest, icon)
const WEB = ["index.html", "logo-full.png"];
const hasFront = () => [path.join(PUB, "index.html"), path.join(__dirname, "index.html")].some(f => fs.existsSync(f));
const MISSING = `<!doctype html><meta charset="utf-8"><title>PLUVIA SENSE</title><body style="font:16px system-ui;max-width:640px;margin:48px auto;padding:0 16px"><h2>PLUVIA SENSE server is running</h2><p>But the web page <b>index.html</b> was not found next to <b>server.js</b>. Upload <b>index.html</b> to the same place as <b>server.js</b> in your repository, then redeploy.</p><p>Le serveur fonctionne, mais le fichier <b>index.html</b> est introuvable à côté de <b>server.js</b>. Ajoutez-le dans le dépôt puis redéployez.</p></body>`;
const ICON = (() => { for (const f of [path.join(PUB, "index.html"), path.join(__dirname, "index.html")]) { try { const m = /rel="icon"[^>]*href="data:image\/png;base64,([^"]+)"/.exec(fs.readFileSync(f, "utf8")); if (m) return Buffer.from(m[1], "base64"); } catch (e) {} } return null; })();
const MANIFEST = JSON.stringify({ name: "PLUVIA SENSE", short_name: "PLUVIA SENSE", start_url: "/", display: "standalone", background_color: "#EEF4F8", theme_color: "#0B3669", icons: ICON ? [{ src: "/icon.png", sizes: "192x192", type: "image/png", purpose: "any" }] : [] });
const SW = `
var V="ps-shell-v2",T="ps-tiles",SHELL=["/","/manifest.webmanifest","/icon.png","https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl.min.js","https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl.min.css"];
var TILE=["arcgisonline.com","elevation-tiles-prod","tiles.openfreemap.org","rainviewer.com"];
self.addEventListener("install",function(e){e.waitUntil(caches.open(V).then(function(c){return Promise.all(SHELL.map(function(u){return c.add(new Request(u,{mode:u[0]==="/"?"same-origin":"no-cors"})).catch(function(){})}))}).then(function(){return self.skipWaiting()}))});
self.addEventListener("activate",function(e){e.waitUntil(caches.keys().then(function(k){return Promise.all(k.filter(function(x){return x!==V&&x!==T}).map(function(x){return caches.delete(x)}))}).then(function(){return self.clients.claim()}))});
function trim(c,max){return c.keys().then(function(k){if(k.length>max)return Promise.all(k.slice(0,k.length-max).map(function(x){return c.delete(x)}))})}
self.addEventListener("fetch",function(e){var r=e.request,u=new URL(r.url);if(r.method!=="GET")return;
 if(u.origin===location.origin){if(u.pathname.indexOf("/api/")===0)return;
  e.respondWith(fetch(r).then(function(res){var cp=res.clone();caches.open(V).then(function(c){c.put(r,cp)});return res}).catch(function(){return caches.match(r,{ignoreSearch:true}).then(function(m){return m||caches.match("/")})}));return}
 if(TILE.some(function(h){return r.url.indexOf(h)>=0})){e.respondWith(caches.open(T).then(function(c){return c.match(r).then(function(m){if(m)return m;return fetch(r).then(function(res){if(res.ok||res.type==="opaque"){c.put(r,res.clone());trim(c,6000)}return res}).catch(function(){return Response.error()})})}));return}
 if(u.hostname==="cdnjs.cloudflare.com"||u.hostname.indexOf("fonts.g")===0){e.respondWith(caches.match(r).then(function(m){return m||fetch(r).then(function(res){var cp=res.clone();caches.open(V).then(function(c){c.put(r,cp)});return res})}))}});
self.addEventListener("message",function(e){var d=e.data;if(!d||d.type!=="cache-tiles")return;
 e.waitUntil(caches.open(T).then(function(c){var n=0;return d.urls.reduce(function(p,u){return p.then(function(){return c.match(u).then(function(m){if(!m)return fetch(u,{mode:"cors"}).then(function(res){if(res.ok)return c.put(u,res)})}).catch(function(){}).then(function(){n++})})},Promise.resolve()).then(function(){return self.clients.matchAll()}).then(function(cl){cl.forEach(function(x){x.postMessage({type:"cache-done",n:n})})})}))});
`;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json", ".jpg": "image/jpeg", ".webm": "video/webm", ".mp4": "video/mp4", ".pdf": "application/pdf" };
function serveStatic(p, res) {
  const rel = p === "/" ? "index.html" : p.replace(/^\/+/, ""), tries = [], a = path.normalize(path.join(PUB, rel));
  if (a.startsWith(PUB + path.sep)) tries.push(a); if (WEB.includes(rel)) tries.push(path.join(__dirname, rel));
  const next = i => { if (i >= tries.length) { res.writeHead(404, { "content-type": "text/html; charset=utf-8" }); return res.end(p === "/" ? MISSING : "Not found"); }
    fs.readFile(tries[i], (e, d) => { if (e) return next(i + 1); res.writeHead(200, { "content-type": MIME[path.extname(tries[i])] || "application/octet-stream", "cache-control": "no-cache" }); res.end(d); }); };
  next(0);
}
// ---- Geocoding (place names, streets, schools, hospitals…) with cache, throttling and a local gazetteer fallback
const gcache = new Map(); let gLast = 0;
async function geocode(q) {
  const key = q.toLowerCase().trim(), c = gcache.get(key); if (c && Date.now() - c.t < 864e5) return c.v;
  const wait = Math.max(0, gLast + 1100 - Date.now()); gLast = Date.now() + wait; if (wait) await new Promise(r => setTimeout(r, wait));
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&accept-language=fr,ar,en&countrycodes=tn&viewbox=${BOX.lon[0]},${BOX.lat[1]},${BOX.lon[1]},${BOX.lat[0]}&bounded=1&q=${encodeURIComponent(q)}${process.env.NOMINATIM_EMAIL ? "&email=" + encodeURIComponent(process.env.NOMINATIM_EMAIL) : ""}`;
  const r = await fetch(url, { headers: { "user-agent": "PLUVIA-SENSE/" + VERSION }, signal: AbortSignal.timeout(8000) }); if (!r.ok) throw new Error(r.status);
  const v = (await r.json()).map(x => ({ name: x.name || String(x.display_name).split(",")[0], display: x.display_name, lat: +x.lat, lon: +x.lon, kind: x.type }));
  if (gcache.size > 500) gcache.clear(); gcache.set(key, { t: Date.now(), v }); return v;
}
const gazetteer = q => { const s = q.toLowerCase(); return NODES.filter(n => n.name.toLowerCase().includes(s)).map(n => ({ name: n.name, display: n.name + " (monitoring point)", lat: n.lat, lon: n.lon, kind: "monitoring point" })); };
// ---- HTTP
const hits = new Map(); const limited = (ip, max = 8, k = "r") => { const t = Date.now(), key = k + ip, a = (hits.get(key) || []).filter(x => t - x < 6e4); a.push(t); hits.set(key, a); if (hits.size > 5000) hits.clear(); return a.length > max; };
async function body(req, max) { const c = []; let n = 0; for await (const x of req) { n += x.length; if (n > max) throw Object.assign(new Error("Payload too large"), { code: 413 }); c.push(x); } return Buffer.concat(c); }
const J = (res, code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
const jpg = (s, max) => { const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(s || ""); if (!m) return null; const b = Buffer.from(m[1], "base64"); return b.length <= max ? b : null; };
const validEmail = s => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s), validPhone = s => /^\+\d{8,15}$/.test(s);
const normPhone = s => String(s || "").replace(/[\s-]/g, "");
const wcache = new Map();
const server = http.createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*"); res.setHeader("access-control-allow-headers", "content-type,authorization,x-ops-token,x-device-key"); res.setHeader("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("x-content-type-options", "nosniff"); res.setHeader("referrer-policy", "no-referrer"); res.setHeader("permissions-policy", "camera=(self), geolocation=(self)");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  let u; try { u = new URL(req.url.replace(/^\/{2,}/, "/"), "http://x"); } catch (e) { res.writeHead(400); return res.end("Bad request"); }
  const p = u.pathname, ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim(), me = who(req, u), ops = !!me && (me.role === "decision" || me.role === "admin"), admin = !!me && me.role === "admin";
  const need = (ok, msg) => { if (!ok) { J(res, me ? 403 : 401, { error: msg }); return false; } return true; };
  const jbody = async (max = 1e4) => JSON.parse((await body(req, max)).toString() || "{}");
  let m;
  try {
    if (p === "/api/health") return J(res, 200, { ok: true, app: "PLUVIA SENSE", version: VERSION, frontend: hasFront(), weather: wxOK, nodes: NODES.length, demo: DEMO });
    if (p === "/sw.js") { res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-cache", "service-worker-allowed": "/" }); return res.end(SW); }
    if (p === "/manifest.webmanifest") { res.writeHead(200, { "content-type": "application/manifest+json", "cache-control": "no-cache" }); return res.end(MANIFEST); }
    if (p === "/icon.png" && ICON) { res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" }); return res.end(ICON); }
    if (p === "/api/state" && req.method === "GET") return J(res, 200, view(me));
    if (p === "/api/stream") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
      const c = { res, me }; clients.add(c); res.write(`retry: 3000\nevent: state\ndata: ${JSON.stringify(view(me))}\n\n`); req.on("close", () => clients.delete(c)); return;
    }
    // --- accounts
    if (p === "/api/auth/register" && req.method === "POST") {   // observers / reporters: open registration
      if (limited(ip, 8, "auth")) return J(res, 429, { error: "Too many attempts. Try again in a minute." });
      const b = await jbody(), email = String(b.email || "").trim().toLowerCase(), phone = normPhone(b.phone), name = String(b.name || "").trim().slice(0, 80);
      if (!name || String(b.password || "").length < 8) return J(res, 400, { error: "Enter your name and a password of at least 8 characters" });
      if (!validEmail(email) && !validPhone(phone)) return J(res, 400, { error: "Enter an e-mail address or a phone number with country code (+216…)" });
      if (db.users.some(x => (email && x.email === email) || (phone && x.phone === phone))) return J(res, 409, { error: "An account already exists with this e-mail or phone" });
      const salt = crypto.randomBytes(16).toString("hex"), usr = { id: "U" + crypto.randomBytes(6).toString("hex"), role: "reporter", name, email: validEmail(email) ? email : "", phone: validPhone(phone) ? phone : "", salt, hash: hashPw(b.password, salt), status: "active", t: Date.now() };
      db.users.push(usr); save(); return J(res, 201, { token: sign({ uid: usr.id, role: "reporter" }, TTL.reporter), user: pubUser(usr) });
    }
    if (p === "/api/auth/request-access" && req.method === "POST") {   // decision makers: restricted, proof required, administrator approves
      if (limited(ip, 5, "areq")) return J(res, 429, { error: "Too many attempts. Try again later." });
      const b = await jbody(4e6), email = String(b.email || "").trim().toLowerCase(), phone = normPhone(b.phone), name = String(b.name || "").trim().slice(0, 80);
      if (!name || !ORGS.includes(b.organization) || !String(b.position || "").trim()) return J(res, 400, { error: "Enter your name, organisation and position" });
      if (!validEmail(email)) return J(res, 400, { error: "Enter your official e-mail address" }); if (String(b.password || "").length < 10) return J(res, 400, { error: "Use a password of at least 10 characters" });
      const m = /^data:(image\/jpeg|application\/pdf);base64,([A-Za-z0-9+/=]+)$/.exec(b.proof || ""); if (!m) return J(res, 400, { error: "Attach a proof of your function (photo of your professional card or official appointment letter, JPG or PDF)" });
      const buf = Buffer.from(m[2], "base64"); if (buf.length > 2.5e6) return J(res, 413, { error: "The proof file is too large (2.5 MB maximum)" });
      if (db.users.some(x => x.email === email)) return J(res, 409, { error: "An account or request already exists with this e-mail" });
      const id = "U" + crypto.randomBytes(6).toString("hex"), file = `proof-${id}.${m[1] === "application/pdf" ? "pdf" : "jpg"}`, salt = crypto.randomBytes(16).toString("hex");
      fs.writeFileSync(media(file), buf);
      db.users.push({ id, role: "decision", name, org: b.organization, position: String(b.position).slice(0, 80), email, phone: validPhone(phone) ? phone : "", salt, hash: hashPw(b.password, salt), status: "pending", t: Date.now(), proof: file, officialDomain: OFFICIAL.some(d => email.endsWith("@" + d) || email.endsWith("." + d)) });
      logEv(null, "access", `Access request from ${name} (${b.organization})`); save(); push("access", { name, org: b.organization }, true); return J(res, 201, { status: "pending" });
    }
    if (p === "/api/auth/login" && req.method === "POST") {
      if (limited(ip, 10, "login")) return J(res, 429, { error: "Too many attempts. Try again in a minute." });
      const b = await jbody(), id = String(b.ident || "").trim().toLowerCase(), usr = db.users.find(x => (x.email && x.email === id) || (x.phone && x.phone === normPhone(id))), ok = usr && eq(hashPw(b.password || "", usr.salt), usr.hash);
      if (!usr) hashPw(b.password || "", "0".repeat(32)); if (!ok) return J(res, 401, { error: "Wrong identifier or password" });
      if (usr.status === "pending") return J(res, 403, { error: "Your access request is still being verified by the administrator" });
      if (usr.status !== "active") return J(res, 403, { error: "This account has not been approved or has been disabled" });
      return J(res, 200, { token: sign({ uid: usr.id, role: usr.role }, TTL[usr.role]), user: pubUser(usr) });
    }
    if (p === "/api/auth/admin" && req.method === "POST") {
      if (limited(ip, 6, "adm")) return J(res, 429, { error: "Too many attempts. Try again in a minute." });
      const b = await jbody(); if (!eq(b.code || "", OPS)) return J(res, 401, { error: "Wrong administrator code" });
      return J(res, 200, { token: sign({ role: "admin" }, TTL.admin), user: { id: "admin", role: "admin", name: "Administrator", status: "active" } });
    }
    if (p === "/api/auth/me") return J(res, 200, { user: me });
    // --- administration: access requests, accounts, site settings, calibration, system health
    if (p === "/api/admin/requests" && req.method === "GET") { if (!need(admin, "Administrator only")) return; return J(res, 200, db.users.filter(x => x.role === "decision").sort((a, b) => b.t - a.t).map(x => ({ ...pubUser(x), position: x.position, email: x.email, phone: x.phone, t: x.t, proof: x.proof, officialDomain: !!x.officialDomain, note: x.note || "" }))); }
    if ((m = /^\/api\/admin\/users\/(\w+)$/.exec(p)) && req.method === "POST") {
      if (!need(admin, "Administrator only")) return; const b = await jbody(), usr = db.users.find(x => x.id === m[1]); if (!usr) return J(res, 404, { error: "Not found" });
      const st = { approve: "active", reject: "rejected", revoke: "revoked" }[b.action]; if (!st) return J(res, 400, { error: "Unknown action" });
      usr.status = st; usr.note = String(b.note || "").slice(0, 200); logEv(null, "access", `${b.action} ${usr.name} (${usr.org || usr.role})`, me.name); save(); broadcast(); return J(res, 200, { ok: true });
    }
    if ((m = /^\/api\/admin\/sites\/(N\d+)$/.exec(p)) && req.method === "POST") {
      if (!need(admin, "Administrator only")) return; const n = NODES.find(x => x.id === m[1]), b = await jbody(); if (!n) return J(res, 404, { error: "Unknown site" });
      const o = db.sites[n.id] = db.sites[n.id] || {};
      if (b.type) { if (!SITE_TYPES[b.type]) return J(res, 400, { error: "Unknown site type" }); o.type = b.type; }
      if (b.thr != null) { if (!(+b.thr >= 30 && +b.thr <= 400)) return J(res, 400, { error: "Threshold must be between 30 and 400 cm" }); o.thr = +b.thr; }
      if (b.criteria) { o.criteria = {}; CRIT.forEach(([k]) => { const v = +b.criteria[k]; o.criteria[k] = clamp(isFinite(v) ? v : 2.5, 0, 5); }); }
      if (b.maintenance != null) { o.maintenance = !!b.maintenance; logEv(n.id, "mode", o.maintenance ? "Maintenance mode ON" : "Maintenance mode OFF", me.name); }
      logEv(n.id, "config", "Site settings updated", me.name); save(); broadcast(); return J(res, 200, { ok: true });
    }
    if ((m = /^\/api\/admin\/sites\/(N\d+)\/calibration$/.exec(p)) && req.method === "POST") {
      if (!need(admin, "Administrator only")) return; const n = NODES.find(x => x.id === m[1]), b = await jbody(); if (!n) return J(res, 404, { error: "Unknown site" });
      const off = +b.offset_cm || 0; if (Math.abs(off) > 50) return J(res, 400, { error: "Offset must be within ±50 cm" });
      (db.calib[n.id] = db.calib[n.id] || []).push({ t: Date.now(), offset_cm: off, note: String(b.note || "").slice(0, 200), by: me.name }); n.q.verify = false; logEv(n.id, "calibration", `Calibration recorded (offset ${off} cm)`, me.name); save(); broadcast(); return J(res, 200, { ok: true });
    }
    if (p === "/api/admin/system" && req.method === "GET") {
      if (!need(admin, "Administrator only")) return; const now = Date.now(), liveN = NODES.filter(n => !n.sim), pts = Object.values(db.series).reduce((a, s) => a + s.length, 0), up = lorawanHits.filter(t => now - t < 36e5).length;
      return J(res, 200, { layers: [
        { layer: "Device firmware", status: `${liveN.length}/${NODES.length} sites reporting`, detail: liveN.length ? `Firmware: ${[...new Set(liveN.map(n => n.q.fw || "unknown"))].join(", ")}` : "No live device yet: sites are simulated" + (DEMO ? " (demo mode)" : "") },
        { layer: "LoRaWAN network", status: `${up} uplink(s) in the last hour`, detail: "POST /api/lorawan/uplink (TTN or ChirpStack webhook)" },
        { layer: "Gateway", status: liveN.some(n => n.q.rssi != null) ? "Signal reported" : "No signal data yet", detail: liveN.filter(n => n.q.rssi != null).map(n => `${n.id}: ${n.q.rssi} dBm / SNR ${n.q.snr ?? "?"}`).join(" · ") || "RSSI and SNR arrive with each uplink" },
        { layer: "Backend", status: `v${VERSION} running`, detail: `Uptime ${Math.round(process.uptime() / 60)} min · authentication, storage, processing, API` },
        { layer: "Database", status: `${pts} time-series points`, detail: `${db.reports.length} reports · ${db.users.length} accounts · ${db.events.length} events (JSON file store; move to PostgreSQL/TimescaleDB for scale)` },
        { layer: "Risk engine", status: DEMO ? "Active (demo mode)" : "Active", detail: "Thresholds, rate of rise, vulnerability, hysteresis, sensor confidence" },
        { layer: "GIS dashboard", status: "This interface", detail: "Map, trends, status and event history" },
        { layer: "Alert service", status: [TW.sid ? "SMS" : null, WEBHOOK ? "Webhook" : null, "In-app"].filter(Boolean).join(" + "), detail: TW.sid || WEBHOOK ? "Approved channels configured" : "Only in-app: configure Twilio or a webhook to reach phones" }] });
    }
    // --- site details (trend, history, calibration) and manual verification
    if ((m = /^\/api\/sites\/(N\d+)$/.exec(p)) && req.method === "GET") {
      if (!need(ops, "Operations access required")) return; const n = NODES.find(x => x.id === m[1]); if (!n) return J(res, 404, { error: "Unknown site" });
      const s = db.series[n.id] || [], step = Math.max(1, Math.ceil(s.length / 150)); return J(res, 200, { series: s.filter((_, i) => i % step === 0 || i === s.length - 1), events: db.events.filter(e => e.node === n.id).slice(0, 40), calibration: (db.calib[n.id] || []).slice(-5).reverse() });
    }
    if ((m = /^\/api\/sites\/(N\d+)\/verify$/.exec(p)) && req.method === "POST") { if (!need(ops, "Operations access required")) return; const n = NODES.find(x => x.id === m[1]); if (!n) return J(res, 404, { error: "Unknown site" }); n.q.verify = false; logEv(n.id, "verify", "Manual verification done", me.name); broadcast(); return J(res, 200, { ok: true }); }
    // --- geocoding and weather
    if (p === "/api/geocode") {
      if (limited(ip, 20, "geo")) return J(res, 429, { error: "Too many searches. Wait a moment." });
      const q = String(u.searchParams.get("q") || "").trim().slice(0, 100); if (q.length < 2) return J(res, 200, { results: [] });
      const g = gazetteer(q); try { const r = await geocode(q); return J(res, 200, { results: [...g, ...r].slice(0, 9) }); } catch (e) { return J(res, 200, { results: g, partial: true }); }
    }
    if (p === "/api/weather") {
      if (limited(ip, 40, "w")) return J(res, 429, { error: "Too many requests" });
      const lat = +u.searchParams.get("lat"), lon = +u.searchParams.get("lon");
      if (!(lat >= BOX.lat[0] && lat <= BOX.lat[1] && lon >= BOX.lon[0] && lon <= BOX.lon[1])) return J(res, 400, { error: "Outside the coverage area" });
      const k = lat.toFixed(2) + "," + lon.toFixed(2), c = wcache.get(k); if (c && Date.now() - c.t < 6e5) return J(res, 200, c.v);
      const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,precipitation,wind_speed_10m&hourly=precipitation&forecast_hours=6&timezone=GMT`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
      if (!r || !r.ok) return J(res, 502, { error: "Weather service unavailable" });
      const j = await r.json(), v = { t: Date.now(), temp: j.current.temperature_2m, rain: j.current.precipitation || 0, wind: j.current.wind_speed_10m, next: j.hourly.time.map((t, i) => ({ t: Date.parse(t + "Z"), mm: j.hourly.precipitation[i] || 0 })) };
      if (wcache.size > 300) wcache.clear(); wcache.set(k, { t: Date.now(), v }); return J(res, 200, v);
    }
    // --- citizen reports
    if (p === "/api/reports" && req.method === "POST") {
      if (limited(ip)) return J(res, 429, { error: "Too many reports. Wait a minute." });
      const b = await jbody(8e6), lat = +b.lat, lon = +b.lon;
      if (!(lat >= BOX.lat[0] && lat <= BOX.lat[1] && lon >= BOX.lon[0] && lon <= BOX.lon[1])) return J(res, 400, { error: "Location is outside the coverage area" });
      if (!TYPES.includes(b.type) || ![1, 2, 3].includes(+b.sev)) return J(res, 400, { error: "Invalid type or severity" });
      const id = "R" + Date.now().toString(36) + crypto.randomBytes(3).toString("hex"), photos = (Array.isArray(b.photos) ? b.photos : []).slice(0, 4).map(s => jpg(s, 1.5e6)).filter(Boolean);
      if (!photos.length && b.video !== true && b.noMedia !== true) return J(res, 400, { error: "A live photo or video is required" });
      photos.forEach((buf, i) => fs.writeFileSync(media(`${id}-${i}.jpg`), buf));
      const r = { id, kind: "report", t: Date.now(), lat, lon, src: ["gps", "search"].includes(b.src) ? b.src : "tap", acc: isFinite(+b.acc) ? +b.acc : null, type: b.type, sev: +b.sev, desc: String(b.desc || "").slice(0, 1000), np: photos.length, video: b.video === true, noMedia: b.noMedia === true, status: "New", uid: me && me.role === "reporter" ? me.id : null, by: me ? me.name : null };
      db.reports.unshift(r); db.reports.length = Math.min(db.reports.length, 500); save(); { const f = full(r); push("report", { id, type: r.type, sev: r.sev, lat, lon, photos: r.np, video: r.video, noMedia: r.noMedia, int: f.intensity, decision: f.decision }, true); } broadcast(); return J(res, 201, { id });
    }
    if ((m = /^\/api\/reports\/(R[\w]+)\/video$/.exec(p)) && req.method === "POST") {
      const r = db.reports.find(x => x.id === m[1]); if (!r || r.vext || Date.now() - r.t > 6e5) return J(res, 404, { error: "Report not found" });
      const ext = /mp4/.test(req.headers["content-type"] || "") ? "mp4" : "webm"; fs.writeFileSync(media(`${r.id}-v.${ext}`), await body(req, 15e6)); r.vext = ext; save(); broadcast(); return J(res, 200, { ok: true });
    }
    // --- sensors: direct HTTP, and LoRaWAN network-server webhooks (TTN v3 / ChirpStack v4)
    if (p === "/api/readings" && req.method === "POST") {
      if (!eq(req.headers["x-device-key"] || "", DEV)) return J(res, 401, { error: "Invalid device key" });
      const b = JSON.parse((await body(req, 3e6)).toString() || "{}"), n = NODES.find(x => x.id === b.node);
      if (!n) return J(res, 404, { error: "Unknown node id" }); const r = ingest(n, b); return J(res, r.code, r.error ? { error: r.error } : out(r));
    }
    if (p === "/api/lorawan/uplink" && req.method === "POST") {
      if (!eq(req.headers["x-device-key"] || u.searchParams.get("key") || "", DEV)) return J(res, 401, { error: "Invalid device key" });
      const b = JSON.parse((await body(req, 3e6)).toString() || "{}"), up = b.uplink_message || {}, dp = up.decoded_payload || b.object || {}, devId = String((b.end_device_ids || {}).device_id || (b.deviceInfo || {}).deviceName || b.node || "").toLowerCase();
      const n = NODES.find(x => devId === x.id.toLowerCase() || devId.endsWith("-" + x.id.toLowerCase()) || devId.endsWith("_" + x.id.toLowerCase())); if (!n) return J(res, 404, { error: "Device name must end with a node id (e.g. pluvia-n4)" });
      const rx = (up.rx_metadata || b.rxInfo || [])[0] || {}; lorawanHits.push(Date.now()); lorawanHits = lorawanHits.filter(t => Date.now() - t < 36e5);
      const r = ingest(n, { level_cm: dp.level_cm, rain_mmh: dp.rain_mmh, battery_pct: dp.battery_pct, fw: dp.fw, event: dp.event, buffered: !!dp.buffered, seq: up.f_cnt != null ? up.f_cnt : b.fCnt, ts: dp.ts || up.received_at || b.time, rssi: rx.rssi, snr: rx.snr != null ? rx.snr : rx.loRaSNR });
      return J(res, r.code, r.error ? { error: r.error } : out(r));
    }
    // --- operations
    if ((m = /^\/api\/items\/(\w+)$/.exec(p)) && req.method === "PATCH") {
      if (!need(ops, "Operations access required")) return; const b = await jbody(), it = db.reports.find(x => x.id === m[1]) || db.alerts.find(x => x.id === m[1]);
      if (!it || !STAT.includes(b.status)) return J(res, 400, { error: "Unknown item or status" }); it.status = b.status; logEv(it.node || null, "status", `${it.type || it.reason} set to ${b.status}`, me.name); save(); broadcast(); return J(res, 200, { ok: true });
    }
    if (p === "/api/sim/storm" && req.method === "POST") { if (!need(ops, "Operations access required")) return; storm = !!(await jbody(1e3)).on; broadcast(); return J(res, 200, { storm }); }
    if (p === "/api/sim/forecast" && req.method === "POST") {
      if (!need(ops, "Operations access required")) return; const b = await jbody(1e3);
      fakeFc = b.on ? { id: Date.now().toString(36), start: Date.now() + (isFinite(+b.startMin) ? +b.startMin : 55) * 6e4, len: (+b.lenH || 3) * 36e5, peak: +b.peak || 22 } : null;
      if (!fakeFc) db.eps = db.eps.filter(e => !e.fake); NODES.forEach(n => n.f3 = 0); episodes(); broadcast(); return J(res, 200, { fake: !!fakeFc });
    }
    if (p === "/api/sim/event" && req.method === "POST") {
      if (!need(ops, "Operations access required")) return; const b = await jbody(1e3), n = NODES.find(x => x.id === b.node) || NODES[3], ev = EVENT_TEXT[b.event] ? b.event : "water_rising";
      if (n.sim) n.L = clamp(n.L + 18, 8, n.thr * 1.5); n.la.cam = Date.now(); raise(n, Math.max(2, n.risk), "camera", EVENT_TEXT[ev]); broadcast(); return J(res, 200, { ok: true });
    }
    if (p === "/api/subscribe" && req.method === "POST") {
      if (limited(ip, 10, "s")) return J(res, 429, { error: "Too many requests. Try again in a minute." });
      const b = await jbody(), role = b.role, lang = ["en", "fr", "ar"].includes(b.lang) ? b.lang : "en";
      if (!["school", "parent", "authority"].includes(role)) return J(res, 400, { error: "Choose school, parent or authority" });
      if (role === "authority" && !ops) return J(res, 401, { error: "Authority subscriptions need an approved decision-maker account" });
      const ph = normPhone(b.phone), mail = String(b.email || "").trim().slice(0, 120), okP = validPhone(ph), okM = validEmail(mail);
      if (!okP && !okM) return J(res, 400, { error: "Enter a phone number with country code (+216…) or an e-mail address" });
      let node = NODES.find(x => x.id === b.node) ? b.node : role === "authority" && b.node === "all" ? "all" : null;
      if (!node && isFinite(+b.lat) && isFinite(+b.lon) && b.lat !== "" && b.lon !== "") node = near({ lat: +b.lat, lon: +b.lon }).id;
      if (!node) return J(res, 400, { error: "Choose your area" }); if (db.subs.length >= 5000) return J(res, 507, { error: "Subscriber limit reached" });
      const sub = { id: crypto.randomBytes(8).toString("hex"), t: Date.now(), role, lang, name: String(b.name || "").slice(0, 80), phone: okP ? ph : "", email: okM ? mail : "", node };
      db.subs.push(sub); save(); return J(res, 201, { id: sub.id, node });
    }
    if ((m = /^\/api\/subscribers\/(\w+)$/.exec(p)) && req.method === "DELETE") { const i = db.subs.findIndex(x => x.id === m[1]); if (i < 0) return J(res, 404, { error: "Not found" }); db.subs.splice(i, 1); save(); return J(res, 200, { ok: true }); }
    if ((m = /^\/api\/media\/([\w.-]+)$/.exec(p))) {
      if (!need(m[1].startsWith("proof-") ? admin : ops, m[1].startsWith("proof-") ? "Administrator only" : "Operations access required")) return;
      return fs.readFile(media(m[1]), (e, d) => { if (e) return J(res, 404, { error: "Not found" }); res.writeHead(200, { "content-type": MIME[path.extname(m[1])] || "application/octet-stream", "cache-control": "private, max-age=3600" }); res.end(d); });
    }
    if (p.startsWith("/api/")) return J(res, 404, { error: "Not found" });
    return serveStatic(p, res);
  } catch (e) { if (!res.headersSent) J(res, e.code === 413 ? 413 : e instanceof SyntaxError ? 400 : 500, { error: e.code === 413 ? e.message : e instanceof SyntaxError ? "Invalid JSON" : "Server error" }); }
});
process.on("uncaughtException", e => console.error("uncaught:", e)); process.on("unhandledRejection", e => console.error("unhandled:", e));
loadWx(); setInterval(loadWx, 3e5); setInterval(tick, 2000); setInterval(episodes, 3e4);
server.listen(PORT, () => console.log(`PLUVIA SENSE v${VERSION} on :${PORT}${DEMO ? " (demo mode: sites without devices are simulated)" : ""}\n  Administrator code : ${OPS}\n  Device key         : ${DEV}\n  (set OPS_TOKEN, DEVICE_KEY, SESSION_SECRET to make these permanent)`));
