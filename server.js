// Butt Trace — Field payouts · sold as intel
const express=require('express'),sharp=require('sharp'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const initSql=require('sql.js');
const PORT=process.env.PORT||8787, DBF=process.env.DB_PATH||path.join(__dirname,'data.sqlite');
const bcrypt=require('bcryptjs'),GEO=require('./geo');
const MODE=()=>setting('reward_mode')||'hybrid'; // hybrid (default) | drop | cash
// ---- revenue-share auto-scaling: pay rises with paid buyer revenue (trailing 30 days) ----
const DEFAULT_TIERS=[{min:0,branded:0.10,unread:0.03,cap:1},{min:1000,branded:0.15,unread:0.05,cap:2},{min:10000,branded:0.25,unread:0.08,cap:5},{min:50000,branded:0.50,unread:0.15,cap:15}];
const TIERS=()=>{try{return JSON.parse(setting('tiers'))}catch(e){return DEFAULT_TIERS}};
const REV30=()=>one("SELECT COALESCE(SUM(amount),0) v FROM orders WHERE status='paid' AND ts>datetime('now','-30 day')").v;
const SHARE=()=>Number(setting('rev_share_pct')||60); // scanners' share of NET revenue; operator keeps the rest and pays prizes from it
const NET=a=>Math.max(0,a-(a*0.029+0.30)); // estimated net after Stripe card fee
const ym=(off=0)=>{const d=new Date();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+off);return d.toISOString().slice(0,7)};
const netFor=m=>all("SELECT amount FROM orders WHERE status='paid' AND strftime('%Y-%m',ts)=?",[m]).reduce((a,o)=>a+NET(o.amount||0),0);
const poolFor=m=>+(netFor(prevYm(m))*SHARE()/100).toFixed(2); // pool for month m = share of month m-1 net
function prevYm(m){const d=new Date(m+'-01T00:00:00Z');d.setUTCMonth(d.getUTCMonth()-1);return d.toISOString().slice(0,7)}
const perScanPaid=m=>one("SELECT COALESCE(SUM(payout),0) v FROM scans WHERE verified=1 AND engine!='demo' AND strftime('%Y-%m',ts)=?",[m]).v;
const bonusFor=m=>one('SELECT COALESCE(SUM(amount),0) v FROM bonuses WHERE month=?',[m]).v;
function econMonth(m){const net=netFor(m),pool=poolFor(m),ps=perScanPaid(m),b=bonusFor(m),prizes=one("SELECT COUNT(*) n FROM winners WHERE substr(day,1,7)=?",[m]).n*Number(setting('prize_value')||20);
  return {month:m,netRevenue:+net.toFixed(2),pool,perScanPaid:+ps.toFixed(2),bonusPaid:+b.toFixed(2),leftover:+Math.max(0,pool-ps-b).toFixed(2),
    operatorShare:+(prevNet(m)*(100-SHARE())/100).toFixed(2),prizeCost:prizes,operatorNet:+(prevNet(m)*(100-SHARE())/100-prizes).toFixed(2)}}
const prevNet=m=>netFor(prevYm(m));
// monthly bonus: leftover pool of month m -> verified scanners pro-rata by verified scans x trust multiplier (flagged users excluded)
function runBonus(m){if(bonusFor(m)>0||one('SELECT 1 x FROM bonuses WHERE month=?',[m]))return {error:'Bonus already distributed for '+m};
  const e=econMonth(m);if(e.leftover<1)return {month:m,leftover:e.leftover,paid:0,note:'nothing to distribute'};
  const rows=all("SELECT u.id,u.name,u.flagged,COUNT(*) n FROM scans s JOIN users u ON u.id=s.user_id WHERE s.verified=1 AND s.kind!='none' AND s.engine!='demo' AND strftime('%Y-%m',s.ts)=? GROUP BY u.id",[m])
    .filter(r=>!r.flagged).map(r=>({...r,w:r.n*level(r).mult}));
  const W=rows.reduce((a,r)=>a+r.w,0);if(!W)return {month:m,leftover:e.leftover,paid:0,note:'no eligible scanners'};
  let tot=0;rows.forEach(r=>{const amt=Math.floor(e.leftover*r.w/W*100)/100;if(amt>0){run("INSERT INTO bonuses(user_id,month,amount,ts) VALUES(?,?,?,datetime('now'))",[r.id,m,amt]);tot+=amt;mail(r.name,'Butt Trace monthly bonus',`Your share of the ${m} scanner pool: $${amt.toFixed(2)}`)}});
  return {month:m,leftover:e.leftover,paid:+tot.toFixed(2),scanners:rows.length}}
setInterval(()=>{if(new Date().getUTCDate()===1&&setting('auto_bonus')!=='0'){const m=ym(-1);if(!one('SELECT 1 x FROM bonuses WHERE month=?',[m]))runBonus(m)}},3600e3);
const AUTO=()=>setting('auto_scale')!=='0';
const TIER=()=>{const r=REV30(),t=TIERS();let i=0;t.forEach((x,k)=>{if(r>=x.min)i=k});return {i,...t[i],next:t[i+1]||null,rev30:r}};
const RATE=()=>AUTO()?{branded:TIER().branded,unread:TIER().unread,none:0}:({branded:Number(setting('rate_branded')||0.10),unread:Number(setting('rate_unread')||0.03),none:0});
const BASE_CAP=()=>AUTO()?TIER().cap:Number(setting('user_daily_cap')||1.00);
// trusted-scanner levels: long clean history multiplies the daily cap
const LEVELS=[{name:'New',mult:1},{name:'Trusted',mult:2,days:14,scans:50,maxRej:0},{name:'Veteran',mult:3,days:60,scans:300,maxRej:0.01}];
function level(u){if(!u)return{i:0,...LEVELS[0]};const h=one("SELECT MIN(ts) f,SUM(verified=1) ok,SUM(verified=-1) rej FROM scans WHERE user_id=? AND kind!='none'",[u.id]);
  const days=h.f?(Date.now()-Date.parse(h.f+'Z'))/864e5:0,ok=h.ok||0,rr=(h.rej||0)/Math.max(1,ok+(h.rej||0));
  const rej30=one("SELECT COUNT(*) n FROM scans WHERE user_id=? AND verified=-1 AND ts>datetime('now','-30 day')",[u.id]).n;
  let i=0;if(!u.flagged){if(days>=14&&ok>=50&&rej30===0)i=1;if(days>=60&&ok>=300&&rr<=0.01&&rej30===0)i=2}return {i,...LEVELS[i],days:Math.floor(days),verified:ok}}
const USER_CAP=u=>+(BASE_CAP()*level(u).mult).toFixed(2);
const DAILY_BUDGET=()=>{const man=Number(setting('daily_cap')||process.env.DAILY_PAYOUT_CAP||200);return AUTO()?Math.max(man,+(poolFor(ym())/30).toFixed(2)):man};
const HOLD_H=Number(process.env.HOLD_HOURS||24);
const payoutsOn=()=>MODE()!=='drop'&&setting('payouts_paused')!=='1';
const CASHOUT_MIN=Number(process.env.CASHOUT_MIN||5);
const PRODUCTS=[
 ['national','National brand litter share','/yr',48000],['heatmap','City sanitation heatmaps','/city/yr',12400],
 ['school','School-buffer brand clusters','/region/yr',31000],['dwell','Smoker-path dwell maps','/market/yr',22500],
 ['polymer','Filter polymer census','/yr',18000],['leak','Convenience-trade leakage','/chain/yr',9800]];
let db;
const setting=(k,v)=>{if(v!==undefined){run('INSERT OR REPLACE INTO settings VALUES(?,?)',[k,String(v)]);return v}const r=one('SELECT v FROM settings WHERE k=?',[k]);return r&&r.v};
const mail=(to,subject,body)=>{run("INSERT INTO outbox(to_addr,subject,body,ts) VALUES(?,?,?,datetime('now'))",[to||'',subject,body]);console.log('[mail-stub]',to,subject)}; // swap for Resend/Postmark later
function backup(){const d=path.join(path.dirname(DBF),'backups');fs.mkdirSync(d,{recursive:true});save();fs.copyFileSync(DBF,path.join(d,'data-'+new Date().toISOString().slice(0,13)+'.sqlite'));fs.readdirSync(d).sort().slice(0,-28).forEach(f=>fs.unlinkSync(path.join(d,f)))}
const save=()=>fs.writeFileSync(DBF,Buffer.from(db.export()));
const all=(q,p=[])=>{const s=db.prepare(q);s.bind(p);const r=[];while(s.step())r.push(s.getAsObject());s.free();return r};
const one=(q,p)=>all(q,p)[0];
const run=(q,p=[])=>{db.run(q,p);save()};

// ---- vision: xAI Grok (OpenAI-compatible) or labeled mock ----
async function classify(jpeg){
  if(process.env.XAI_API_KEY){
    const r=await fetch('https://api.x.ai/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.XAI_API_KEY},
      body:JSON.stringify({model:process.env.XAI_VISION_MODEL||'grok-4',temperature:0,response_format:{type:'json_object'},messages:[{role:'user',content:[
       {type:'image_url',image_url:{url:'data:image/jpeg;base64,'+jpeg.toString('base64'),detail:'high'}},
       {type:'text',text:'Is there a discarded cigarette butt in this photo? If yes, read the brand printed on the filter/tipping paper if legible. Reply JSON only: {"butt":bool,"brand":string|null,"confidence":0-1}'}]}]})});
    if(!r.ok) throw new Error('xAI '+r.status);
    const j=await r.json(); const o=JSON.parse(j.choices[0].message.content.replace(/```json|```/g,''));
    return {butt:!!o.butt&&(o.confidence??1)>=0.5,brand:o.brand||null,confidence:o.confidence??null,engine:'xai'};
  }
  // MOCK: deterministic from image bytes — NOT real detection
  const h=crypto.createHash('md5').update(jpeg).digest()[0];
  const brands=['Marlboro','Newport','Camel','Pall Mall','Winston'];
  return h<26?{butt:false,brand:null,engine:'mock'}:{butt:true,brand:h%2?brands[h%5]:null,engine:'mock'};
}
async function dhash(buf){const px=await sharp(buf).greyscale().resize(9,8,{fit:'fill'}).raw().toBuffer();let b='';for(let y=0;y<8;y++)for(let x=0;x<8;x++)b+=px[y*9+x]<px[y*9+x+1]?1:0;return b}
const ham=(a,b)=>{if(!a||a.length!==b.length)return 99;let d=0;for(let i=0;i<a.length;i++)if(a[i]!==b[i])d++;return d};

// ---- stripe via REST (no SDK) ----
async function stripe(p,params,method='POST'){
  const k=process.env.STRIPE_SECRET_KEY; if(!k) return null;
  const r=await fetch('https://api.stripe.com/v1/'+p,{method,...(method==='GET'?{headers:{Authorization:'Bearer '+k}}:{}),...(method==='GET'?{}:{headers:{Authorization:'Bearer '+k,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(params)})});
  const j=await r.json(); if(j.error) throw new Error(j.error.message); return j;
}

const app=express();
app.post('/api/stripe/webhook',express.raw({type:'*/*'}),(req,res)=>{
  const sec=process.env.STRIPE_WEBHOOK_SECRET; if(!sec) return res.status(400).end();
  const sig=Object.fromEntries((req.get('stripe-signature')||'').split(',').map(x=>x.split('=')));
  const exp=crypto.createHmac('sha256',sec).update(sig.t+'.'+req.body).digest('hex');
  if(exp!==sig.v1) return res.status(400).end('bad sig');
  const ev=JSON.parse(req.body);
  if(ev.type==='checkout.session.completed'){const o=ev.data.object;run("UPDATE orders SET status='paid',email=?,amount=? WHERE session=?",[o.customer_details?.email||'',(o.amount_total||0)/100,o.id]);
    const key='bt_'+crypto.randomBytes(18).toString('hex');run("INSERT INTO apikeys VALUES(?,?,datetime('now'))",[key,o.customer_details?.email||o.id]);
    mail(o.customer_details?.email,'Butt Trace receipt + API key',`Thanks for your order. Your data API key: ${key}\nCSV: ${process.env.BASE_URL||''}/api/v1/export.csv?key=${key}`);}
  res.json({ok:1});
});
app.use(express.json({limit:'8mb'}));app.use(express.static(path.join(__dirname,'public')));
const user=(req,res,next)=>{const u=one('SELECT * FROM users WHERE token=?',[req.get('x-token')||'']);if(!u)return res.status(401).json({error:'sign in'});req.u=u;next()};

const uname=x=>String(x||'').trim().toLowerCase().replace(/[^a-z0-9_]/g,'');
const phoneNorm=x=>{const d=String(x||'').replace(/\D/g,'').replace(/^1(?=\d{10}$)/,'');return d.length===10?'+1'+d:null};
async function sendSMS(to,body){ // STUB: swap for Twilio Verify (TWILIO_* env). Logged to admin Outbox.
  mail(to,'SMS',body);}
app.post('/api/register',async(req,res)=>{const n=uname(req.body.username),pw=String(req.body.password||''),ph=phoneNorm(req.body.phone);
  if(n.length<2)return res.status(400).json({error:'username 2+ chars'});if(pw.length<8)return res.status(400).json({error:'password 8+ chars'});
  if(!ph)return res.status(400).json({error:'US mobile number required'});if(!req.body.agree18)return res.status(400).json({error:'Confirm you are 18+ in the US and accept the terms'});
  if(one('SELECT 1 x FROM users WHERE name=?',[n]))return res.status(409).json({error:'username taken'});
  if(one('SELECT 1 x FROM users WHERE phone=?',[ph]))return res.status(409).json({error:'That phone number already has an account (one account per phone)'});
  const code=String(crypto.randomInt(100000,1000000)),tok=crypto.randomBytes(24).toString('hex');
  run('INSERT INTO users(name,token,pass_hash,phone,phone_verified,sms_code) VALUES(?,?,?,?,0,?)',[n,tok,bcrypt.hashSync(pw,10),ph,code]);
  await sendSMS(ph,'Butt Trace code: '+code);
  res.json({token:tok,name:n,needVerify:true,...(process.env.SMS_PROVIDER?{}:{devCode:code})})});
app.post('/api/login',(req,res)=>{const u=one('SELECT * FROM users WHERE name=?',[uname(req.body.username)]);
  if(!u||!u.pass_hash||!bcrypt.compareSync(String(req.body.password||''),u.pass_hash))return res.status(401).json({error:'wrong username or password'});
  res.json({token:u.token,name:u.name,needVerify:!u.phone_verified})});
app.post('/api/verify-phone',(req,res)=>{const u=one('SELECT * FROM users WHERE token=?',[req.get('x-token')||'']);if(!u)return res.status(401).json({error:'sign in'});
  if(String(req.body.code)!==u.sms_code)return res.status(400).json({error:'wrong code'});run('UPDATE users SET phone_verified=1,sms_code=NULL WHERE id=?',[u.id]);res.json({ok:1})});
app.get('/api/transparency',(q,r)=>{const t=one("SELECT COALESCE(SUM(amount),0) v FROM orders WHERE status='paid'").v,paid=one('SELECT COALESCE(SUM(amount),0) v FROM payouts').v;
  r.json({share:SHARE(),lifetimeRevenue:+t.toFixed(2),lifetimeNet:+all("SELECT amount FROM orders WHERE status='paid'").reduce((a,o)=>a+NET(o.amount||0),0).toFixed(2),lifetimePaidOut:+paid.toFixed(2),lastMonth:econMonth(ym(-1)),thisMonth:econMonth(ym())})});
app.get('/api/config',(q,r)=>r.json({share:SHARE(),mode:MODE(),rates:RATE(),userCap:USER_CAP(null),tiers:TIERS(),tier:TIER().i,autoScale:AUTO(),levels:LEVELS,holdHours:HOLD_H,payoutsOn:payoutsOn(),vision:process.env.XAI_API_KEY?'xai':'mock',stripe:!!process.env.STRIPE_SECRET_KEY,cashoutMin:CASHOUT_MIN}));

app.post('/api/scan',user,async(req,res)=>{
  const {image,lat,lng,city}=req.body;
  if(typeof lat!=='number'||typeof lng!=='number') return res.status(400).json({error:'GPS required'});
  if(!req.u.phone_verified) return res.status(403).json({error:'Verify your phone number first'});
  const place=GEO.city(lat,lng); if(!place) return res.status(400).json({error:'US only — no US town within 80 km of this location'});
  const near=all("SELECT lat,lng FROM scans WHERE user_id=? AND date(ts)=date('now')",[req.u.id]).some(p=>GEO.dist(p.lat,p.lng,lat,lng)<10);
  if(near) return res.status(409).json({error:'Too close (<10 m) to one of your scans today — move on to a new spot'});
  const recent=one("SELECT COUNT(*) c FROM scans WHERE user_id=? AND ts>datetime('now','-1 minute')",[req.u.id]).c;
  if(recent>=6) return res.status(429).json({error:'Rate limit: 6 scans/min'});
  let buf=Buffer.from(String(image||'').split(',').pop(),'base64');
  try{
    buf=await sharp(buf).rotate().resize(768,768,{fit:'inside'}).jpeg({quality:80}).toBuffer();
    const h=await dhash(buf);
    const dup=all("SELECT phash FROM scans WHERE ts>datetime('now','-7 day')").some(r=>ham(r.phash,h)<=4);
    if(dup) return res.status(409).json({error:'Duplicate photo rejected'});
    const v=await classify(buf);
    const kind=!v.butt?'none':v.brand?'branded':'unread';
    const earned=one("SELECT COALESCE(SUM(payout),0) v FROM scans WHERE user_id=? AND date(ts)=date('now') AND verified>=0",[req.u.id]).v;
    const pay=MODE()==='drop'?0:+Math.max(0,Math.min(RATE()[kind],USER_CAP(req.u)-earned)).toFixed(2), capped=MODE()!=='drop'&&kind!=='none'&&pay<RATE()[kind];
    const flags=[];
    if(v.engine!=='xai') flags.push('mock-engine');
    if(typeof req.body.acc==='number'&&req.body.acc>100) flags.push('gps-accuracy>100m');
    const last=one('SELECT lat,lng,ts FROM scans WHERE user_id=? ORDER BY id DESC LIMIT 1',[req.u.id]);
    if(last){const km=Math.hypot(last.lat-lat,(last.lng-lng)*Math.cos(lat*Math.PI/180))*111,mins=(Date.now()-Date.parse(last.ts+'Z'))/6e4;if(km/Math.max(mins,1)*60>150)flags.push('gps-jump');}
    const today=one("SELECT COUNT(*) n FROM scans WHERE user_id=? AND ts>datetime('now','start of day')",[req.u.id]).n;
    if(today>300) flags.push('daily-volume>300');
    if(v.confidence!=null&&v.confidence<0.75) flags.push('low-confidence');
    const status=flags.length?0:1; // 1 auto-approved, 0 review queue
    run("INSERT INTO scans(user_id,ts,lat,lng,city,brand,kind,payout,phash,engine,verified,flags) VALUES(?,datetime('now'),?,?,?,?,?,?,?,?,?,?)",
      [req.u.id,lat,lng,place,v.brand,kind,pay,h,v.engine,kind==='none'?1:status,flags.join(',')]);
    res.json({kind,brand:v.brand,payout:pay,capped,city:place,mode:MODE(),entries:kind==='none'?0:1,status:status?'approved':'in review',flags,engine:v.engine,utc:new Date().toISOString(),lat,lng});
  }catch(e){res.status(500).json({error:e.message})}
  finally{buf.fill(0);buf=null} // image discarded, never stored
});
app.get('/api/ledger',user,(req,res)=>{
  const rows=all('SELECT ts,flags,city,brand,kind,payout,engine,verified FROM scans WHERE user_id=? ORDER BY id DESC LIMIT 200',[req.u.id]);
  const s=one(`SELECT COALESCE(SUM(CASE WHEN verified>=0 THEN payout END),0) t,COALESCE(SUM(CASE WHEN verified=1 THEN payout END),0) v,
    COALESCE(SUM(CASE WHEN verified=1 AND ts<=datetime('now','-${HOLD_H} hours') THEN payout END),0) w FROM scans WHERE user_id=?`,[req.u.id]);
  const out=one("SELECT COALESCE(SUM(amount),0) p FROM payouts WHERE user_id=?",[req.u.id]).p;
  const bon=one('SELECT COALESCE(SUM(amount),0) v FROM bonuses WHERE user_id=?',[req.u.id]).v;s.w+=bon;
  const today=one("SELECT COALESCE(SUM(payout),0) v FROM scans WHERE user_id=? AND date(ts)=date('now') AND verified>=0",[req.u.id]).v;
  res.json({name:req.u.name,phoneVerified:!!req.u.phone_verified,rows,total:s.t,verified:s.v,onHold:+(s.v-s.w).toFixed(2),paidOut:out,available:+(s.w-out).toFixed(2),todayEarned:today,bonus:bon,userCap:USER_CAP(req.u),level:level(req.u),connected:!!req.u.stripe_acct})});
app.post('/api/connect',user,async(req,res)=>{try{
  if(!process.env.STRIPE_SECRET_KEY) return res.status(503).json({error:'Payouts not configured yet (STRIPE_SECRET_KEY missing)'});
  let a=req.u.stripe_acct; if(!a){a=(await stripe('accounts',{type:'express','capabilities[transfers][requested]':'true'})).id;run('UPDATE users SET stripe_acct=? WHERE id=?',[a,req.u.id])}
  const base=process.env.BASE_URL||`http://localhost:${PORT}`;
  const l=await stripe('account_links',{account:a,type:'account_onboarding',refresh_url:base+'/#ledger',return_url:base+'/#ledger'});res.json({url:l.url})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/cashout',user,async(req,res)=>{try{
  const s=one(`SELECT COALESCE(SUM(payout),0) v FROM scans WHERE user_id=? AND verified=1 AND ts<=datetime('now','-${HOLD_H} hours')`,[req.u.id]).v+one('SELECT COALESCE(SUM(amount),0) v FROM bonuses WHERE user_id=?',[req.u.id]).v-one('SELECT COALESCE(SUM(amount),0) p FROM payouts WHERE user_id=?',[req.u.id]).p;
  if(MODE()==='drop') return res.status(400).json({error:'Cash payouts are off — Daily Drop mode.'});
  if(!req.u.phone_verified) return res.status(403).json({error:'Verify your phone first'});
  if(s<CASHOUT_MIN) return res.status(400).json({error:`Minimum cashout $${CASHOUT_MIN}. Verified available $${s.toFixed(2)}`});
  if(!req.u.stripe_acct) return res.status(400).json({error:'Connect a payout account first'});
  const ext=await stripe('accounts/'+req.u.stripe_acct+'/external_accounts?limit=10',null,'GET');
  const fps=(ext.data||[]).map(x=>x.fingerprint).filter(Boolean);if(!fps.length) return res.status(400).json({error:'Finish Stripe onboarding (add a bank/debit card) first'});
  if(all('SELECT bank_fp FROM users WHERE id!=? AND bank_fp IS NOT NULL',[req.u.id]).some(r=>fps.includes(r.bank_fp))){run("UPDATE users SET flagged='shared-payout-account' WHERE id=?",[req.u.id]);return res.status(409).json({error:'That bank/card is already linked to another Butt Trace account (one account per payout account). Contact support.'})}
  run('UPDATE users SET bank_fp=? WHERE id=?',[fps[0],req.u.id]);
  if(setting('payouts_paused')==='1') return res.status(503).json({error:'Payouts are paused by the operator. Your balance is safe.'});
  const spent=one("SELECT COALESCE(SUM(amount),0) p FROM payouts WHERE ts>datetime('now','start of day')").p;
  if(spent+s>DAILY_BUDGET()) return res.status(503).json({error:'Daily payout budget reached; try again tomorrow.'});
  const t=await stripe('transfers',{amount:String(Math.floor(s*100)),currency:'usd',destination:req.u.stripe_acct});
  run("INSERT INTO payouts(user_id,amount,ref,ts) VALUES(?,?,?,datetime('now'))",[req.u.id,Math.floor(s*100)/100,t.id]);
  mail(req.u.name,'Butt Trace payout receipt',`Paid $${s.toFixed(2)} to your Stripe account. Ref ${t.id}.`);res.json({ok:1,amount:s})}catch(e){res.status(500).json({error:e.message})}});

app.post('/api/lead',(req,res)=>{const b=req.body;if(!/.+@.+\..+/.test(b.email||''))return res.status(400).json({error:'valid email required'});
  run("INSERT INTO leads(name,email,org,interest,msg,ts) VALUES(?,?,?,?,?,datetime('now'))",[b.name||'',b.email,b.org||'',b.interest||'',String(b.msg||'').slice(0,2000)]);
  mail(process.env.OPERATOR_EMAIL||'operator','New Butt Trace lead: '+(b.org||b.email),JSON.stringify(b));res.json({ok:1})});
app.get('/sample-report',(req,res)=>{const br=all("SELECT brand,COUNT(*) n FROM scans WHERE kind='branded' GROUP BY brand ORDER BY n DESC"),tot=br.reduce((a,x)=>a+x.n,0)||1,
  ci=all("SELECT city,COUNT(*) n,ROUND(100.0*SUM(kind='branded')/COUNT(*)) pb FROM scans WHERE kind!='none' GROUP BY city ORDER BY n DESC");
  res.send(`<!doctype html><meta name=viewport content="width=device-width"><title>Butt Trace sample report</title><body style="font:15px system-ui;max-width:760px;margin:auto;padding:20px"><h1>Butt Trace — Sample Brand Litter Report</h1><p style="background:#ffe9b0;padding:8px">SAMPLE built from DEMO/synthetic data. Real reports use verified field scans.</p><h2>Brand share of identified litter</h2><table>${br.map(x=>`<tr><td>${x.brand}</td><td>${(100*x.n/tot).toFixed(1)}%</td></tr>`).join('')}</table><h2>City density</h2><table><tr><th>City</th><th>Butts logged</th><th>% brand-read</th></tr>${ci.map(x=>`<tr><td>${x.city}</td><td>${x.n}</td><td>${x.pb}%</td></tr>`).join('')}</table><p><a href="/#desk">Request a quote or start the $99/mo City Starter →</a></p>`)});
app.get('/api/desk',(req,res)=>{
  const t=one("SELECT COUNT(*) n,SUM(kind='branded') b,SUM(kind='unread') u,COUNT(DISTINCT city) c,COALESCE(SUM(payout),0) cogs FROM scans WHERE kind!='none'");
  res.json({totals:t,
   brands:all("SELECT brand,COUNT(*) n FROM scans WHERE kind='branded' GROUP BY brand ORDER BY n DESC"),
   hours:all("SELECT CAST(strftime('%H',ts) AS INT) h,COUNT(*) n FROM scans WHERE kind!='none' GROUP BY h"),
   cities:all("SELECT city,COUNT(*) n FROM scans WHERE kind!='none' GROUP BY city ORDER BY n DESC"),
   points:all("SELECT lat,lng,kind FROM scans WHERE kind!='none' ORDER BY id DESC LIMIT 1500"),
   products:PRODUCTS.map(([id,name,unit,price])=>({id,name,unit,price})),demo:one("SELECT COUNT(*) n FROM scans WHERE engine='demo'").n})});
app.post('/api/checkout',async(req,res)=>{try{
  if(req.body.product==='starter'){if(!process.env.STRIPE_SECRET_KEY)return res.status(503).json({error:'Checkout not configured yet (STRIPE_SECRET_KEY missing). No charge made.'});
    const base=process.env.BASE_URL||`http://localhost:${PORT}`;const s=await stripe('checkout/sessions',{mode:'subscription','line_items[0][quantity]':'1','line_items[0][price_data][currency]':'usd',
     'line_items[0][price_data][unit_amount]':'9900','line_items[0][price_data][recurring][interval]':'month','line_items[0][price_data][product_data][name]':'Butt Trace City Starter (1 city, monthly CSV + dashboard)',
     success_url:base+'/#desk?paid=1',cancel_url:base+'/#desk'});run("INSERT INTO orders(product,session,status,ts) VALUES('starter',?,'pending',datetime('now'))",[s.id]);return res.json({url:s.url})}
  const p=PRODUCTS.find(x=>x[0]===req.body.product);if(!p)return res.status(404).json({error:'no product'});
  if(!process.env.STRIPE_SECRET_KEY) return res.status(503).json({error:'Checkout not configured yet (STRIPE_SECRET_KEY missing). No charge made.'});
  const base=process.env.BASE_URL||`http://localhost:${PORT}`;
  const s=await stripe('checkout/sessions',{mode:'payment','line_items[0][quantity]':'1','line_items[0][price_data][currency]':'usd',
   'line_items[0][price_data][unit_amount]':String(p[3]*100),'line_items[0][price_data][product_data][name]':'Butt Trace — '+p[1]+' ('+p[2]+')',
   success_url:base+'/#desk?paid=1',cancel_url:base+'/#desk'});
  run("INSERT INTO orders(product,session,status,ts) VALUES(?,?,'pending',datetime('now'))",[p[0],s.id]);res.json({url:s.url})}catch(e){res.status(500).json({error:e.message})}});

const DROP=require('./drop')(app,{all,one,run,setting:(...a)=>setting(...a),mail:(...a)=>mail(...a),user});
require('./ops')(app,{econ:()=>({tiers:TIERS(),tier:TIER(),share:SHARE(),auto:AUTO(),budget:DAILY_BUDGET(),pool30:poolFor(ym()),levels:LEVELS,thisMonth:econMonth(ym()),lastMonth:econMonth(ym(-1))}),runBonus:m=>runBonus(m||ym(-1)),all,one,run,setting:(...a)=>setting(...a),mail:(...a)=>mail(...a),save:()=>save(),DBF,PRODUCTS,user});
(async()=>{const SQL=await initSql();db=fs.existsSync(DBF)?new SQL.Database(fs.readFileSync(DBF)):new SQL.Database();
 db.run(`CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,name TEXT UNIQUE,token TEXT,stripe_acct TEXT,pass_hash TEXT,phone TEXT UNIQUE,phone_verified INT DEFAULT 0,sms_code TEXT,bank_fp TEXT,flagged TEXT);
 CREATE TABLE IF NOT EXISTS scans(id INTEGER PRIMARY KEY,user_id INT,ts TEXT,lat REAL,lng REAL,city TEXT,brand TEXT,kind TEXT,payout REAL,phash TEXT,engine TEXT,verified INT,flags TEXT);
 CREATE TABLE IF NOT EXISTS bonuses(id INTEGER PRIMARY KEY,user_id INT,month TEXT,amount REAL,ts TEXT);
 CREATE TABLE IF NOT EXISTS votes(user_id INT,day TEXT,opt INT);
 CREATE TABLE IF NOT EXISTS leads(id INTEGER PRIMARY KEY,name TEXT,email TEXT,org TEXT,interest TEXT,msg TEXT,ts TEXT);
 CREATE TABLE IF NOT EXISTS amoe(user_id INT,day TEXT);
 CREATE TABLE IF NOT EXISTS winners(id INTEGER PRIMARY KEY,day TEXT,user_id INT,name TEXT,prize TEXT,entries INT,ts TEXT);
 CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY,v TEXT);
 CREATE TABLE IF NOT EXISTS apikeys(key TEXT PRIMARY KEY,buyer TEXT,ts TEXT);
 CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY,to_addr TEXT,subject TEXT,body TEXT,ts TEXT);
 CREATE TABLE IF NOT EXISTS payouts(id INTEGER PRIMARY KEY,user_id INT,amount REAL,ref TEXT,ts TEXT);
 CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY,product TEXT,session TEXT,status TEXT,ts TEXT,email TEXT,amount REAL);`);
 if(!one('SELECT COUNT(*) n FROM scans').n){ // DEMO seed data (engine='demo', unverified, never paid)
  run("INSERT OR IGNORE INTO users(name,token) VALUES('demo_seed','x')");const uid=one("SELECT id FROM users WHERE name='demo_seed'").id;
  const C=[['Chattanooga',35.045,-85.309],['Atlanta',33.749,-84.388],['Nashville',36.162,-86.781],['Knoxville',35.96,-83.92],['East Ridge',35.012,-85.252]];
  const B=['Marlboro','Newport','Camel','Pall Mall','Winston','L&M'];
  db.run('BEGIN');for(let i=0;i<600;i++){const c=C[Math.floor(Math.random()**1.5*C.length)],br=Math.random()<.62,h=Math.floor(7+Math.random()*16);
   db.run(`INSERT INTO scans(user_id,ts,lat,lng,city,brand,kind,payout,phash,engine,verified,flags) VALUES(?,datetime('now','-${Math.floor(Math.random()*30)} day','start of day','+${h} hour'),?,?,?,?,?,?,?,'demo',0,'demo')`,
   [uid,c[1]+(Math.random()-.5)*.08,c[2]+(Math.random()-.5)*.08,c[0],br?B[Math.floor(Math.random()**1.4*B.length)]:null,br?'branded':'unread',br?.42:.14,'d'+i])}
  db.run('COMMIT');save()}
 setInterval(backup,6*3600e3);backup();
 app.listen(PORT,()=>console.log('Butt Trace on :'+PORT))})();
