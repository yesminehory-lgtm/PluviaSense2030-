# PLUVIA SENSE - urban pluvial flood early-warning platform (TSYP14)

**Run:** `node server.js` (Node 18+, no npm install), open http://localhost:3000. In a second terminal `node simulate.js` plays a storm on 5 demo sensor/camera nodes.

## What it does
1. **Real-time map**: 3D satellite view (Esri imagery + AWS terrain + OpenFreeMap 3D buildings, MapLibre GL) with live layers: model rain grid from Open-Meteo (refreshed every 5-10 min), RainViewer radar (past 2 h, coarse), sensor nodes, reports. Needs internet.
2. **Citizen report**: tap the map (or *Use my location*) -> wizard opens and starts the camera. A **live camera photo or video is required**. If the camera cannot start, the user may send a described report marked *unverified*. The weather at the pin is shown.
3. **Decision-maker alert** (Control room tab): every report appears at once with its photo, **risk intensity (0-100, LOW/MODERATE/HIGH/CRITICAL)** and a **suggested decision**, plus other actions and a status workflow. Risk combines severity, credibility, rain at the pin and nearby sensor risk.
4. **Automatic detection**: nodes post readings. The server flags rising water, high level or a node-reported suspicious event, answers `capture:true`, and the node sends a camera frame; the alert reaches the control room with the frame attached.
5. **Forecast warnings**: the server watches the hourly forecast (area maximum). When intense rain (>=10 mm/h) is forecast it sends a heads-up (if within 12 h) and a warning **1 hour before**, to authorities, schools and parents: rain window, estimated road cut-off start, estimated reopening and duration, "do not risk crossing flooded roads", "pupils stay at school until the all-clear". An all-clear is sent automatically after the estimated reopening if no sensor is in alert, or manually.

## Notifications
Subscribers (parents and schools register with *Get alerts*; authorities are seeded). Every message is logged in the control-room outbox. For real SMS/WhatsApp set `SMS_WEBHOOK_URL`: the server POSTs `{to,role,text}` for each real contact (connect it to your SMS gateway).
Use **Demo: heavy rain in 55 min** in the control room to see a full warning cycle without waiting for real rain.

## Node API (header `x-node-key`, default `demo-key`, env `NODE_KEY`)
`POST /api/readings {"id":"PS-01","rain":32,"wl":28,"battery":90,"lat":..,"lon":..,"ts":ms,"event":"optional","snapshot":"data URL of a camera frame"}` -> `{level,capture}`.

## Be aware
- Satellite imagery is recent, not live video. Live = sensors, reports, rainfall layers, alerts.
- Forecast is a global model via Open-Meteo, not an official warning (INM). Thresholds (rain 10/20/40 mm/h, water 15/30/50 cm), road cut-off and reopening estimates, and the 5 node positions are illustrative: calibrate with local data.
- "Live" capture is enforced in the app (camera only, timestamp checked); a determined attacker could spoof it. Production needs device attestation, authentication for the control room, HTTPS (camera/GPS off localhost), a real database and a rate limit.
- Check Esri / OpenFreeMap / RainViewer terms (attribution shown) before public deployment.
