// PLUVIA SENSE back end - zero dependencies, Node >= 18.  Run: node server.js
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const PORT=+process.env.PORT||3000,KEY=process.env.NODE_KEY||'demo-key',HOOK=process.env.SMS_WEBHOOK_URL||'';
const DATA=path.join(__dirname,'data'),MEDIA=path.join(DATA,'media'),DBF=path.join(DATA,'db.json'),PUB=path.join(__dirname,'public');
fs.mkdirSync(MEDIA,{recursive:true});
let db={reports:[],subscribers:[],outbox:[],warnings:[]};try{Object.assign(db,JSON.parse(fs.readFileSync(DBF,'utf8')))}catch{}
if(!db.subscribers.length)db.subscribers=[{id:'A1',role:'authority',name:'Civil protection duty officer (demo)',contact:'demo'},{id:'A2',role:'authority',name:'Municipality operations (demo)',contact:'demo'},
 {id:'S1',role:'school',name:'Demo school A',contact:'demo'},{id:'S2',role:'school',name:'Demo school B',contact:'demo'},{id:'P1',role:'parent',name:'Demo parent (school A)',contact:'demo'},{id:'P2',role:'parent',name:'Demo parent (school B)',contact:'demo'}];
const persist=()=>fs.writeFile(DBF,JSON.stringify(db),()=>{});
const THRESH={rain:[10,20,40],wl:[15,30,50]}; // ILLUSTRATIVE (mm/h, cm): calibrate with INM / field data
const ACT={flood:{1:['Raise monitoring frequency on this node','Notify the duty engineer'],2:['Alert civil protection','Send a team to inspect drains and the low point','Warn drivers near underpasses through the app'],
 3:['Alert civil protection and mobilise pumps','Close and divert flooded roads','Alert nearby schools and hospitals','Open the emergency coordination cell']},
 accident:['Alert emergency services (ambulance, civil protection)','Send traffic police and divert traffic','Publish an alternative route in the app'],drain:['Dispatch the drain-cleaning crew'],power:['Alert the utility and secure the area'],other:['Assign an operator to verify the report']};
const GEN={drain:'the drain-cleaning crew',power:'the utility and a safety team',other:'an operator'};
function decide(type,rl){if(type==='flood')return{LOW:'Log it and monitor; request a follow-up photo',MODERATE:'Send an inspection team to the location',HIGH:'Dispatch a pump/drainage crew, warn drivers and prepare a road closure',CRITICAL:'Alert civil protection now, close and divert the road, secure people at risk'}[rl];
 if(type==='accident')return{LOW:'Send traffic police to assess',MODERATE:'Send traffic police with an ambulance on standby',HIGH:'Dispatch ambulance and civil protection, divert traffic',CRITICAL:'Dispatch all emergency services now and close the road'}[rl];
 const g=GEN[type];return{LOW:'Log it and schedule a check',MODERATE:`Dispatch ${g}`,HIGH:`Dispatch ${g} urgently`,CRITICAL:`Dispatch ${g} immediately and secure the area`}[rl]}
const RL=r=>r>=80?'CRITICAL':r>=60?'HIGH':r>=30?'MODERATE':'LOW',SEV=['','WATCH','WARNING','SEVERE'],TRIG={rising:'Water level rising',high:'High water level',event:'Suspicious event'};
const SEED=[['PS-01','Lac 1 (demo)',36.833,10.235],['PS-02','Ariana (demo)',36.8625,10.1956],['PS-03','Ben Arous (demo)',36.7531,10.2189],['PS-04','La Manouba (demo)',36.8081,10.0971],['PS-05','Tunis centre (demo)',36.7992,10.18]];
const sensors={},hist={},clients=new Set(),pending={},lastAlert={},lastSnap={};
SEED.forEach(([id,name,lat,lon])=>sensors[id]={id,name,lat,lon,rain:0,wl:0,level:0,risk:0,offline:true,pred:{slope:0},actions:[]});
const lvl=(v,t)=>v>=t[2]?3:v>=t[1]?2:v>=t[0]?1:0,sum=a=>a.reduce((x,y)=>x+y,0);
const state=()=>({sensors:Object.values(sensors),reports:db.reports.slice(0,100),warnings:db.warnings.slice(0,5),outbox:db.outbox.slice(0,12),subs:db.subscribers.reduce((a,s)=>(a[s.role]=(a[s.role]||0)+1,a),{})});
const emit=(type,data)=>{const m=`data:${JSON.stringify({type,data})}\n\n`;clients.forEach(c=>c.write(m))};
setInterval(()=>clients.forEach(c=>c.write(':\n\n')),25000);
function km(a,b,c,d){const t=x=>x*Math.PI/180,h=Math.sin(t(c-a)/2)**2+Math.cos(t(a))*Math.cos(t(c))*Math.sin(t(d-b)/2)**2;return 12742*Math.asin(Math.sqrt(h))}
function nearest(lat,lon){let b=null;for(const s of Object.values(sensors)){if(s.offline)continue;const d=km(lat,lon,s.lat,s.lon);if(!b||d<b.d)b={s,d}}return b}
function predict(id){const h=(hist[id]||[]).slice(-6);if(h.length<3)return{slope:0,in30:null,eta:null};
 const x=h.map(p=>(p.ts-h[0].ts)/60000),y=h.map(p=>p.wl),n=h.length,den=n*sum(x.map(v=>v*v))-sum(x)**2||1,s=(n*sum(x.map((v,i)=>v*y[i]))-sum(x)*sum(y))/den,cur=y[n-1];
 return{slope:+s.toFixed(2),in30:+Math.max(0,cur+s*30).toFixed(1),eta:s>0.05&&cur<THRESH.wl[2]?Math.round((THRESH.wl[2]-cur)/s):null}}
// ---------- media ----------
const EXT={'image/jpeg':'jpg','image/png':'png','video/webm':'webm','video/mp4':'mp4','video/quicktime':'mov'};
function saveMedia(id,data,i,internal){const mt=/^data:([\w/+.-]+);base64,(.+)$/.exec(data||'');if(!mt)return null;const ext=EXT[mt[1]]||(internal&&mt[1]==='image/svg+xml'?'svg':null);if(!ext)return null; // SVG only from our own camera nodes
 const f=`${id}-${i}.${ext}`;fs.writeFileSync(path.join(MEDIA,f),Buffer.from(mt[2],'base64'));return{kind:/webm|mp4|mov/.test(ext)?'video':'image',url:'/media/'+f,live:true}}
// ---------- weather (Open-Meteo, real time) ----------
const PTS=[36.70,36.755,36.81,36.865,36.92].flatMap(la=>[10.0,10.09,10.18,10.27,10.36].map(lo=>[la,lo]));
let wx={t:0,fail:0,times:[],pts:[],error:null},demo=null;
const tms=s=>Date.parse(s+':00+01:00'); // Tunisia is UTC+1 all year
async function loadWx(){if(wx.pts.length&&Date.now()-wx.t<6e5||Date.now()-wx.fail<6e4)return;
 try{const u='https://api.open-meteo.com/v1/forecast?latitude='+PTS.map(p=>p[0]).join(',')+'&longitude='+PTS.map(p=>p[1]).join(',')+'&current=precipitation&hourly=precipitation&forecast_days=2&timezone=Africa%2FTunis';
  const j=await(await fetch(u,{signal:AbortSignal.timeout(8000)})).json(),a=Array.isArray(j)?j:[j];
  wx={t:Date.now(),fail:0,error:null,times:a[0].hourly.time.map(tms),pts:a.map((o,i)=>({lat:PTS[i][0],lon:PTS[i][1],now:o.current.precipitation||0,h:o.hourly.precipitation}))}}catch{wx.fail=Date.now();wx.error='weather unavailable'}}
const nearestPt=(la,lo)=>wx.pts.reduce((b,q)=>!b||km(la,lo,q.lat,q.lon)<km(la,lo,b.lat,b.lon)?q:b,null);
const series=pt=>wx.times.map((t,i)=>({t,p:pt.h[i]||0})).filter(h=>h.t>Date.now()-36e5);
const areaHours=()=>demo?demo.hours:wx.pts.length?wx.times.map((t,i)=>({t,p:Math.max(...wx.pts.map(q=>q.h[i]||0))})).filter(h=>h.t>Date.now()-36e5):[];
const rainAt=(la,lo)=>demo?demo.now:wx.pts.length?nearestPt(la,lo).now:0;
function wsum(la,lo){if(demo)return{source:'Open-Meteo (DEMO forecast)',updated:Date.now(),now:demo.now,next:demo.hours.filter(h=>h.t>Date.now()-36e5).slice(0,7)};
 if(!wx.pts.length)return{error:wx.error||'weather unavailable'};const pt=la!=null?nearestPt(la,lo):null;
 return{source:'Open-Meteo',updated:wx.t,now:pt?pt.now:Math.max(...wx.pts.map(q=>q.now)),next:(pt?series(pt):areaHours()).slice(0,7)}}
const grid=()=>({type:'FeatureCollection',features:wx.pts.map(q=>({type:'Feature',geometry:{type:'Point',coordinates:[q.lon,q.lat]},properties:{p:demo?demo.now:q.now}}))});
// ---------- forecast-driven warnings ----------
const hhmm=ms=>new Date(ms).toLocaleTimeString('en-GB',{timeZone:'Africa/Tunis',hour:'2-digit',minute:'2-digit'});
function windows(hs){const out=[];let c=null;
 for(const h of hs)if(h.p>=THRESH.rain[0]){if(c&&h.t-c.e<=36e5){c.e=h.t;c.peak=Math.max(c.peak,h.p)}else{c={s:h.t,e:h.t,peak:h.p};out.push(c)}}
 return out.filter(w=>w.e>Date.now()).map(w=>{const level=lvl(w.peak,THRESH.rain),start=w.s-36e5,end=w.e,release=end+[0,30,60,120][level]*6e4,cutStart=Math.min(end,start+(level>=2?30:60)*6e4); // heuristic estimates
  return{start,end,peak:+w.peak.toFixed(1),level,cutStart,release,cutMin:Math.round((release-cutStart)/6e4)}})}
const dur=m=>m<60?`${m} min`:`${+(m/60).toFixed(1)} h`;
function msgs(W,stage){if(stage==='clear')return{authority:'All clear: the intense-rainfall episode is over and no sensor is in alert. Reopen roads after inspection.',school:'ALL CLEAR: it is now safe. You may release pupils to their parents.',parent:'ALL CLEAR: the rain episode is over and roads are safe again. Pupils can be picked up from school.'};
 const lead=stage==='t60'?'In about 1 hour':'Later today',win=`${hhmm(W.start)} to ${hhmm(W.end)}`,cut=`from about ${hhmm(W.cutStart)}`,rel=`${hhmm(W.release)} (cut-off about ${dur(W.cutMin)})`,tag=`[PLUVIA SENSE ${SEV[W.level]}] ${lead}: intense rainfall ${win}`;
 return{authority:`${tag} (peak ${W.peak} mm/h). Roads at low points likely cut ${cut}, reopening around ${rel}. Suggested: pre-position pumps, inspect drains, brief civil protection, prepare underpass closures.`,
  school:`${tag}. Roads may be cut ${cut} and reopen around ${rel}. Keep all pupils inside the school until the all-clear message. Do not release pupils into flooded streets.`,
  parent:`${tag}. Roads may be cut ${cut} and are expected to reopen around ${rel}. Stay safe and do not risk crossing flooded roads. Pupils will stay at school until the crisis is over; you will be notified when it is safe.`}}
function deliver(s,text,wid,stage){const real=s.contact&&s.contact!=='demo';db.outbox.unshift({ts:Date.now(),to:s.name,role:s.role,contact:s.contact||'-',channel:real?(HOOK?'webhook':'queued (no gateway)'):'demo',stage,warning:wid,text});db.outbox=db.outbox.slice(0,300);
 if(real&&HOOK)fetch(HOOK,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({to:s.contact,role:s.role,text})}).catch(()=>{})}
function dispatch(W,stage){const m=msgs(W,stage),n={authority:0,school:0,parent:0};
 for(const s of db.subscribers)if(m[s.role]){n[s.role]++;deliver(s,m[s.role],W.id,stage)}
 (W.log=W.log||[]).push({ts:Date.now(),stage,sent:n,text:m});persist();emit('warning',W)}
function checkWarnings(){const now=Date.now();
 for(const w of windows(areaHours())){let W=db.warnings.find(x=>x.status==='active'&&Math.abs(x.start-w.start)<=72e5);
  if(!W){W={id:'W'+w.start,status:'active',stages:{},...w};db.warnings.unshift(W)}else Object.assign(W,w);
  const to=W.start-now;
  if(to<=36e5&&!W.stages.t60){W.stages.t60=now;dispatch(W,'t60')}else if(to>36e5&&to<=432e5&&!W.stages.headsup&&!W.stages.t60){W.stages.headsup=now;dispatch(W,'headsup')}}
 for(const W of db.warnings)if(W.status==='active'&&now>W.release&&!Object.values(sensors).some(s=>s.level>=2)){W.status='cleared';W.stages.clear=now;dispatch(W,'clear')}
 db.warnings=db.warnings.slice(0,20)}
setInterval(()=>loadWx().then(checkWarnings).catch(()=>{}),30000);setTimeout(()=>loadWx().then(checkWarnings),2000);
// ---------- reports and sensor ingest ----------
function addReport(b,internal){const id=crypto.randomBytes(6).toString('hex'),media=[];
 (b.media||[]).slice(0,4).forEach((m,i)=>{const x=saveMedia(id,m.data,i,internal);if(x){x.live=!!internal||(m.live===true&&Date.now()-(+m.capturedAt||0)<6e5);media.push(x)}});
 const lat=+b.lat,lon=+b.lon,near=nearest(lat,lon),live=media.filter(m=>m.live).length,sev=Math.min(3,Math.max(1,+b.severity||1));
 let v=(live?50:0)+(live>1?10:0)+(media.some(m=>m.kind==='video')?10:0)+(b.description?10:0)+(b.gps?10:0)+(near&&near.d<1.5&&near.s.level>=1?20:0);
 if(internal)v=media.length?100:80;
 const type=['flood','accident','drain','power','other'].includes(b.type)?b.type:'other',
  risk=b.risk!=null?b.risk:Math.min(100,Math.round(sev*18+v*.25+Math.min(20,rainAt(lat,lon)*1.2)+(near?near.s.risk*.25:0))),rl=RL(risk);
 const r={id,type,severity:sev,description:String(b.description||'').slice(0,1000),lat,lon,gps:!!b.gps,media,live:live>0,source:internal?b.source:'citizen',trigger:b.trigger||null,
  verification:Math.min(100,v),risk,riskLevel:rl,decision:decide(type,rl),status:'new',ts:Date.now(),actions:type==='flood'?ACT.flood[rl==='LOW'?1:rl==='MODERATE'?2:3]:ACT[type],nearest:near&&{name:near.s.name,km:+near.d.toFixed(2),level:near.s.level}};
 db.reports.unshift(r);db.reports=db.reports.slice(0,300);persist();emit('report',r);return r}
function ingest(b){const id=String(b.id).slice(0,32),p=sensors[id]||{};
 const s=sensors[id]={...p,id,name:b.name||p.name||id,lat:+b.lat||p.lat,lon:+b.lon||p.lon,rain:+b.rain||0,wl:+b.wl||0,battery:b.battery??p.battery,ts:+b.ts||Date.now(),offline:false};
 const h=hist[id]=hist[id]||[],prev=h[h.length-1];h.push({ts:s.ts,wl:s.wl});if(h.length>30)h.shift();
 s.level=Math.max(lvl(s.rain,THRESH.rain),lvl(s.wl,THRESH.wl));s.pred=predict(id);s.risk=Math.min(100,Math.round(1.1*s.rain+s.wl+Math.max(0,s.pred.slope)*4));s.actions=s.level?ACT.flood[s.level]:[];
 const ev=b.event?String(b.event).slice(0,60):null,trig=s.level>=2?'high':ev?'event':((prev&&s.wl-prev.wl>=8)||(h.length>=3&&s.pred.slope>=.5&&s.wl>=5))?'rising':null;
 if(b.snapshot){lastSnap[id]=Date.now();const r=db.reports.find(x=>x.id===pending[id]);delete pending[id];if(r&&!r.media.length){const m=saveMedia(r.id,b.snapshot,0,true);if(m){r.media.push(m);r.source='sensor+camera';r.verification=100;persist();emit('report',r)}}}
 const la=lastAlert[id]||{t:0,lvl:0};
 if(trig&&(Date.now()-la.t>3e5||s.level>la.lvl)){lastAlert[id]={t:Date.now(),lvl:s.level};
  const r=addReport({type:'flood',severity:Math.max(1,s.level),risk:s.risk,trigger:trig,lat:s.lat,lon:s.lon,source:b.snapshot?'sensor+camera':'sensor',
   description:`Automatic alert from ${s.name}: ${TRIG[trig]} (water ${s.wl} cm, trend ${s.pred.slope} cm/min, rain ${s.rain} mm/h)${ev?`; camera event: ${ev}`:''}.`,media:b.snapshot?[{data:b.snapshot}]:[]},true);
  if(!b.snapshot)pending[id]=r.id}
 emit('sensor',s);return{level:s.level,capture:!!(trig||s.level>=1)&&Date.now()-(lastSnap[id]||0)>12e4}}
// ---------- HTTP ----------
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.webm':'video/webm','.mp4':'video/mp4','.mov':'video/quicktime'};
const send=(res,c,o)=>{res.writeHead(c,{'Content-Type':'application/json'});res.end(JSON.stringify(o))};
const body=req=>new Promise((ok,no)=>{const ch=[];let n=0;req.on('data',c=>{n+=c.length;if(n>25e6){no(new Error('payload too large'));req.destroy()}else ch.push(c)});req.on('end',()=>{try{ok(JSON.parse(Buffer.concat(ch).toString()||'{}'))}catch(e){no(e)}})});
http.createServer(async(req,res)=>{try{const u=new URL(req.url,'http://x'),p=u.pathname,q=u.searchParams;
 if(p==='/api/stream'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache',Connection:'keep-alive'});res.write(`data:${JSON.stringify({type:'state',data:state()})}\n\n`);clients.add(res);req.on('close',()=>clients.delete(res));return}
 if(p==='/api/state')return send(res,200,state());
 if(p.startsWith('/api/weather')){await loadWx();if(p==='/api/weather/grid')return send(res,200,grid());return send(res,200,p==='/api/weather/at'?wsum(+q.get('lat'),+q.get('lon')):wsum())}
 if(p==='/api/readings'&&req.method==='POST'){if(req.headers['x-node-key']!==KEY)return send(res,401,{error:'bad node key'});const b=await body(req);if(!b.id)return send(res,400,{error:'id required'});return send(res,200,ingest(b))}
 if(p==='/api/reports'&&req.method==='POST'){const b=await body(req);if(!isFinite(+b.lat)||!isFinite(+b.lon))return send(res,400,{error:'lat/lon required'});
  const live=(b.media||[]).some(m=>m.live===true&&Date.now()-(+m.capturedAt||0)<6e5&&/^data:(image|video)\//.test(m.data||''));
  if(!live&&!(b.noCamera&&b.description))return send(res,422,{error:'A live camera photo or video is required (or a description if the camera is unavailable)'});
  return send(res,201,addReport(b,false))}
 if(p==='/api/subscribe'&&req.method==='POST'){const b=await body(req);if(!['parent','school'].includes(b.role)||!b.name||!b.contact)return send(res,400,{error:'role, name and contact required'});
  db.subscribers.push({id:crypto.randomBytes(4).toString('hex'),role:b.role,name:String(b.name).slice(0,60),contact:String(b.contact).slice(0,60),school:String(b.school||'').slice(0,60)});persist();return send(res,201,{ok:true})}
 if(p==='/api/demo/forecast'){if(req.method==='DELETE'){demo=null;return send(res,200,{demo:false})}
  const b=await body(req),t0=Math.ceil(Date.now()/36e5)*36e5,s=Date.now()+(+b.startInMin||55)*6e4,e=s+(+b.durationH||2)*36e5,pk=+b.peak||28;
  demo={now:0,hours:Array.from({length:24},(_,i)=>{const t=t0+i*36e5;return{t,p:t>s&&t-36e5<e?pk:.3}})};checkWarnings();return send(res,200,{demo:true,windows:windows(demo.hours)})}
 let m=/^\/api\/warnings\/(\w+)\/clear$/.exec(p);
 if(m&&req.method==='POST'){const W=db.warnings.find(x=>x.id===m[1]);if(!W)return send(res,404,{});if(W.status==='active'){W.status='cleared';W.stages.clear=Date.now();dispatch(W,'clear')}return send(res,200,W)}
 m=/^\/api\/reports\/(\w+)$/.exec(p);
 if(m&&req.method==='PATCH'){const b=await body(req),r=db.reports.find(x=>x.id===m[1]);if(!r)return send(res,404,{});if(['new','acknowledged','dispatched','resolved'].includes(b.status))r.status=b.status;persist();emit('report',r);return send(res,200,r)}
 if(p.startsWith('/media/')){const f=path.join(MEDIA,path.basename(p));if(!fs.existsSync(f))return send(res,404,{});res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream','Content-Security-Policy':"default-src 'none'; sandbox"});return fs.createReadStream(f).pipe(res)}
 const f=path.join(PUB,p==='/'?'index.html':path.normalize(p));
 if(!f.startsWith(PUB)||!fs.existsSync(f)||fs.statSync(f).isDirectory())return send(res,404,{error:'not found'});
 res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(res)
}catch(e){send(res,400,{error:e.message})}}).listen(PORT,()=>console.log(`PLUVIA SENSE running on http://localhost:${PORT}`));
