# PLUVIA SENSE — pluvial flood watch

Real-time flood detection, citizen reporting, decision support and early warnings.
Backend: Node >= 18, **no dependencies**. Front end: one page (`index.html`, MapLibre GL) served by the backend.

## Files (all at the top level of the repository, no sub-folders)
    server.js      backend: accounts, API, risk engine, data quality, warnings, live stream, offline support
    index.html     front end: satellite 3D map, sign-in, report wizard, operations dashboard (logos embedded)
    package.json   tells the host how to start the app
    render.yaml    optional: Render Blueprint that creates the service with the right settings

## Run locally
    OPS_TOKEN=choose-a-code DEVICE_KEY=choose-a-key node server.js     # then open http://localhost:3000

## Deploy on Render
Upload the files to a GitHub repository, then Render > New > Blueprint > pick the repository > Apply
(or New > Web Service with Build `npm install`, Start `node server.js`). Check `/api/health`:
you must see `"app":"PLUVIA SENSE"` and `"frontend":true`. Use a persistent disk and `DATA_DIR` in production.

## Who can do what
| Role | How to get it | Can |
|---|---|---|
| Guest | nothing | view the map, forecast and warnings; report an incident |
| Observer / Reporter | create an account (e-mail or phone + password) | same, and the control room sees who reported (higher credibility) |
| Decision maker | **request access with proof**; the administrator approves | Operations: alerts with photos, triage, site details, status changes, warnings |
| Administrator | the `OPS_TOKEN` code | approves or revokes decision makers, edits sites, records calibrations, sees system health |

A decision-maker request needs name, organisation (Protection Civile, municipality, ONAS, ministry…), position, official
e-mail, password (10+ characters) and a **proof document** (photo/scan of the professional card or an official appointment
letter, JPG or PDF). The administrator opens the proof, sees whether the e-mail domain is on the official list
(`OFFICIAL_DOMAINS`), then approves or rejects. Sessions: 12 h for decision makers, 8 h for the administrator.

## Risk engine
Variables: **water level**, **rainfall intensity**, **rate of rise**, **site threshold**, **site vulnerability**, **sensor confidence**.
- Levels: Watch / Warning / Critical from level vs threshold, rain intensity, rate of rise and forecast; ETA to overflow.
- **Vulnerability** (0-100) comes from the survey criteria below: vulnerable sites warn earlier (thresholds shifted up to 25 %).
- **Hysteresis**: a level goes up immediately but comes down one step at a time, only after sustained improvement.
- **Confidence**: a low-confidence sensor alone cannot trigger Critical (capped at Warning until a camera event or a nearby report confirms).
- **Modes** (the device receives `mode` and `next_interval_s` in every response): Normal (5 min), Heavy rain (1 min),
  Emergency (10 s, after a confirmed warning), Maintenance (alerts suppressed; set by the administrator).

### Data quality
Range checks (0-500 cm), rate checks (a jump above 20 cm/min is held until a second reading confirms it), missing data
(frame counter gaps), communication timeout, battery and signal monitoring, calibration records (offset applied; overdue after
180 days), and manual verification after unusual events. Each issue lowers the confidence and is listed for the site.

### Site priority (administrator scores each criterion 0-5)
Previous flood history (very high), low elevation (high), drainage vulnerability (high), population exposure (high),
critical infrastructure (high), road importance (medium to high), communication feasibility (medium), maintenance access (medium).
Site types and preferred sensing: road / open low point -> non-contact ultrasonic; storm drain / catch basin -> pressure based
where feasible; critical infrastructure -> redundant sensing; community point -> rain gauge plus observations.
The 8 sites in `server.js` are **proposals**: edit coordinates, then tune type, threshold and scores in Admin.

## Architecture
Device firmware -> LoRaWAN network -> gateway -> **backend** (authentication, storage, processing, API) -> database ->
risk engine -> GIS dashboard -> alert service. The Admin tab shows the live status of each layer.
The database is a JSON file (`DATA_DIR/db.json`): move to PostgreSQL/TimescaleDB when you scale.

## Sensors
**LoRaWAN (recommended).** In The Things Network: Integrations > Webhooks > Custom webhook, base URL
`https://YOUR-APP`, uplink path `/api/lorawan/uplink`, header `x-device-key: YOUR_DEVICE_KEY`. Name devices so that the
id ends with the site id, e.g. `pluvia-n4`. ChirpStack v4 webhooks also work. Payload formatter (8-byte frame):

    function decodeUplink(input){var b=input.bytes;return{data:{
      level_cm:((b[0]<<8)|b[1])/10, rain_mmh:((b[2]<<8)|b[3])/10, battery_pct:b[4],
      buffered:!!(b[5]&1), event:["","water_rising","suspicious","blocked_drain"][(b[5]>>1)&3], fw:b[6]+"."+b[7]}}}

**HTTP** (Wi-Fi/LTE devices):

    curl -X POST https://YOUR-APP/api/readings -H "content-type: application/json" -H "x-device-key: YOUR_DEVICE_KEY" \
      -d '{"node":"N4","level_cm":87.5,"rain_mmh":22,"seq":1042,"ts":1760000000000,"battery_pct":88,"rssi":-104,"snr":6,
           "fw":"1.2.0","event":"water_rising","frame":"data:image/jpeg;base64,..."}'

Firmware outline: wake up on the interval given by the last response -> take 5 readings and keep the median -> attach a
timestamp and an incrementing `seq` -> send; if there is no network, store frames in flash and send them later with
`buffered:true` -> include battery and signal -> run self-diagnostics (sensor in range, supply voltage).
Without `DEMO_MODE=0`, sites that have no device are simulated from live rainfall so the demo works.

## Alerts and warnings
Intense-rain forecasts (>= `HEAVY_MM_H`, default 8 mm/h) trigger an early notice, a warning about 1 hour before (time
window, roads cut off, expected reopening) and an all-clear, in English, French and Arabic, to subscribed schools, parents
and authorities. Approved channels: in-app (always), SMS (`TWILIO_SID`, `TWILIO_TOKEN`, `TWILIO_FROM`), and a webhook
(`WEBHOOK_URL`) for WhatsApp / Telegram / e-mail gateways. Without a provider, warnings are logged as *not sent*.

## Offline use
A service worker keeps the app, the last public data and every map tile you view. "Save map offline" stores the visible area
(up to ~400 satellite tiles). A report made without a connection is stored on the device and sent automatically when the
connection returns. Needs https (or localhost). Check your tile provider's terms before bulk downloads; for large areas
use your own tile server.

## Environment variables
`OPS_TOKEN` administrator code · `DEVICE_KEY` sensors · `SESSION_SECRET` signs sessions · `DEMO_MODE` (default 1) ·
`OFFICIAL_DOMAINS` (default gov.tn) · `DATA_DIR` · `HEAVY_MM_H` · `TWILIO_*` · `WEBHOOK_URL` · `NOMINATIM_EMAIL` (contact for place search).

## Notes
- Base imagery: Esri World Imagery (not live). Names come from OpenStreetMap via OpenFreeMap. Live layer: radar (RainViewer). Rain: Open-Meteo.
- Risk levels, intensity and suggested decisions are rule-based; calibrate with ONAS / municipal data before operational use.
- Accounts, phone numbers and proof documents are personal data stored in `DATA_DIR`: protect the disk and follow local data-protection law.
- Use https in production; rotate `OPS_TOKEN` if it leaks.
