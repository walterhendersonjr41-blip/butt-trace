// Daily Drop sweepstakes. One entry per person per day (verified scan OR free entry). Users vote tomorrow's prize.
module.exports=(app,{all,one,run,setting,mail,user})=>{
  const admin=(req,res,next)=>{const t=process.env.ADMIN_TOKEN;if(!t||req.get('x-admin')!==t)return res.status(401).json({error:'admin token required'});next()};
  const mode=()=>setting('reward_mode')||'hybrid';
  const pool=day=>all(`SELECT u.id,u.name,1 n FROM (
      SELECT user_id FROM scans WHERE verified=1 AND kind!='none' AND engine!='demo' AND date(ts)=?
      UNION SELECT user_id FROM amoe WHERE day=?) x JOIN users u ON u.id=x.user_id`,[day,day]);
  const opts=()=>{try{return JSON.parse(setting('prize_options'))}catch(e){return['Large pizza','$20 gift card','Wing combo']}};
  const prev=d=>new Date(Date.parse(d)-864e5).toISOString().slice(0,10);
  const tally=day=>{const o=opts();const v=all('SELECT opt,COUNT(*) n FROM votes WHERE day=? GROUP BY opt',[day]);return o.map((name,i)=>({i,name,n:(v.find(x=>x.opt===i)||{}).n||0}))};
  const prizeFor=day=>{const t=tally(prev(day)).sort((a,b)=>b.n-a.n);return t[0]&&t[0].n?t[0].name:(setting('prize')||'$20 pizza / gift card')};
  const sponsor=()=>setting('sponsor_name')?{name:setting('sponsor_name'),logo:setting('sponsor_logo')||'',link:setting('sponsor_link')||''}:null;
  const today=()=>new Date().toISOString().slice(0,10);
  const canVote=uid=>!!one("SELECT 1 x FROM scans WHERE user_id=? AND verified=1 AND kind!='none' AND date(ts)=?",[uid,today()]);
  function draw(day,count){
    if(one('SELECT COUNT(*) n FROM winners WHERE day=?',[day]).n) return {error:'Already drawn for '+day};
    const p=pool(day),out=[],prize=prizeFor(day);
    for(let k=0;k<count&&p.length;k++){const tot=p.reduce((a,x)=>a+x.n,0);let r=require('crypto').randomInt(tot);const i=p.findIndex(x=>(r-=x.n)<0);const w=p.splice(i,1)[0];
      run("INSERT INTO winners(day,user_id,name,prize,entries,ts) VALUES(?,?,?,?,?,datetime('now'))",[day,w.id,w.name,prize,w.n]);out.push(w.name);
      mail(w.name,'You won the Butt Trace Daily Drop!',`You won ${prize} for ${day}. Reply within 7 days to claim.`)}
    return {day,winners:out,poolSize:p.length+out.length}}
  const yday=()=>new Date(Date.now()-864e5).toISOString().slice(0,10);
  setInterval(()=>{if(setting('auto_draw')==='1'&&mode()!=='cash')draw(yday(),Number(setting('winners_per_day')||1))},3600e3);
  app.get('/api/drop',(q,r)=>r.json({mode:mode(),prize:prizeFor(today()),sponsor:sponsor(),winnersPerDay:Number(setting('winners_per_day')||1),
    winners:all("SELECT day,name,prize FROM winners ORDER BY id DESC LIMIT 15").map(w=>({...w,name:w.name.slice(0,2)+'***'}))}));
  app.get('/api/drop/me',user,(q,r)=>{const d=new Date().toISOString().slice(0,10);r.json({today:(pool(d).find(x=>x.id===q.u.id)||{n:0}).n,amoeUsed:!!one('SELECT 1 x FROM amoe WHERE user_id=? AND day=?',[q.u.id,d]),
    canVote:canVote(q.u.id),voted:(one('SELECT opt FROM votes WHERE user_id=? AND day=?',[q.u.id,d])||{opt:null}).opt,tally:tally(d),prize:prizeFor(d)})});
  app.post('/api/vote',user,(q,r)=>{const d=today(),i=Number(q.body.opt);if(!canVote(q.u.id))return r.status(403).json({error:'Make one verified scan today to vote'});
    if(!(i>=0&&i<opts().length))return r.status(400).json({error:'bad option'});if(one('SELECT 1 x FROM votes WHERE user_id=? AND day=?',[q.u.id,d]))return r.status(400).json({error:'Already voted today'});
    run('INSERT INTO votes(user_id,day,opt) VALUES(?,?,?)',[q.u.id,d,i]);r.json({ok:1,tally:tally(d)})});
  app.post('/api/amoe',user,(q,r)=>{const d=new Date().toISOString().slice(0,10);if(one('SELECT 1 x FROM amoe WHERE user_id=? AND day=?',[q.u.id,d]))return r.status(400).json({error:'Free entry already used today'});
    run('INSERT INTO amoe(user_id,day) VALUES(?,?)',[q.u.id,d]);r.json({ok:1,entries:1})});
  app.get('/api/admin/drop',admin,(q,r)=>{const d=q.query.day||yday();const p=pool(d);r.json({day:d,prize:prizeFor(d),options:opts(),tally:tally(today()),sponsor:sponsor(),mode:mode(),auto:setting('auto_draw')==='1',pool:p.length,entries:p.reduce((a,x)=>a+x.n,0),drawn:all('SELECT name,prize FROM winners WHERE day=?',[d])})});
  app.post('/api/admin/draw',admin,(q,r)=>r.json(draw(q.body.day||yday(),Math.min(2,Math.max(1,Number(q.body.count)||1)))));
  app.post('/api/admin/drop-settings',admin,(q,r)=>{const b=q.body;if(b.mode)setting('reward_mode',['cash','drop','hybrid'].includes(b.mode)?b.mode:'hybrid');
    if(b.rate_branded!=null)setting('rate_branded',Math.max(0,Math.min(1,Number(b.rate_branded))));if(b.rate_unread!=null)setting('rate_unread',Math.max(0,Math.min(1,Number(b.rate_unread))));if(b.user_daily_cap!=null)setting('user_daily_cap',Math.max(0,Math.min(20,Number(b.user_daily_cap))));if('auto' in b)setting('auto_draw',b.auto?1:0);if(b.prize)setting('prize',b.prize);if(Array.isArray(b.options)&&b.options.length===3)setting('prize_options',JSON.stringify(b.options.map(String)));
    if('sponsor_name' in b){setting('sponsor_name',b.sponsor_name||'');setting('sponsor_logo',b.sponsor_logo||'');setting('sponsor_link',b.sponsor_link||'')}
    if(b.winnersPerDay)setting('winners_per_day',Math.min(2,Number(b.winnersPerDay)));r.json({ok:1})});
  return {mode};
};
