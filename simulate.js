// Hardware-node simulator: behaves like an ESP32 node with sensors + camera.  Run: node simulate.js
// Protocol: node posts readings; the server answers {level,capture}. When capture is true (or the node sees danger itself) the next reading carries a camera frame.
const URL_=process.env.URL||'http://localhost:3000',KEY=process.env.NODE_KEY||'demo-key';
const N=[['PS-01','Lac 1 (demo)',36.833,10.235,1,0],['PS-02','Ariana (demo)',36.8625,10.1956,.8,4],['PS-03','Ben Arous (demo)',36.7531,10.2189,1.05,2],['PS-04','La Manouba (demo)',36.8081,10.0971,.45,6],['PS-05','Tunis centre (demo)',36.7992,10.18,.7,8]].map(([id,name,lat,lon,k,d])=>({id,name,lat,lon,k,d,wl:0,want:false}));
const svg=n=>'data:image/svg+xml;base64,'+Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#1b3b52"/><rect y="${Math.max(120,300-n.wl*3)}" width="640" height="360" fill="#3b7fa8"/><text x="20" y="40" fill="#fff" font-size="22" font-family="sans-serif">CAMERA FRAME - ${n.name}</text><text x="20" y="70" fill="#9fd" font-size="18" font-family="sans-serif">water level ${n.wl.toFixed(0)} cm</text></svg>`).toString('base64');
let step=0;const t0=Date.now();
setInterval(async()=>{step++;for(const n of N){const t=step-n.d,rain=Math.max(0,60*n.k*Math.exp(-((t-25)**2)/150)+Math.random()*2);
 n.wl=Math.max(0,n.wl+rain*.06-.35);const b={id:n.id,name:n.name,lat:n.lat,lon:n.lon,rain:+rain.toFixed(1),wl:+n.wl.toFixed(1),battery:+(92-step*.05).toFixed(1),ts:t0+step*60000};
 if(n.id==='PS-05'&&step===12)b.event='unidentified object in water'; // on-device camera detection
 if(n.want||n.wl>32){b.snapshot=svg(n);n.want=false}
 try{const r=await fetch(URL_+'/api/readings',{method:'POST',headers:{'Content-Type':'application/json','x-node-key':KEY},body:JSON.stringify(b)});if((await r.json()).capture)n.want=true}catch(e){console.log('server unreachable');return}}
 if(step%10===0)console.log('step',step)},1500);
