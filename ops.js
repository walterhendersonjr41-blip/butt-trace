// Operator routes: admin, health, buyer export
module.exports=(app,{all,one,run,setting,DBF,econ,runBonus})=>{
  const admin=(req,res,next)=>{const t=process.env.ADMIN_TOKEN;if(!t||req.get('x-admin')!==t)return res.status(401).json({error:'admin token required (set ADMIN_TOKEN)'});next()};
  app.get('/healthz',(q,r)=>{try{one('SELECT 1 x');r.json({ok:true,vision:process.env.XAI_API_KEY?'xai':'mock',stripe:!!process.env.STRIPE_SECRET_KEY,payoutsPaused:setting('payouts_paused')==='1'})}catch(e){r.status(500).json({ok:false})}});
  app.get('/api/admin/summary',admin,(q,r)=>{
    const rev=one("SELECT COALESCE(SUM(amount),0) v,COUNT(*) n FROM orders WHERE status='paid'");
    const paid=one('SELECT COALESCE(SUM(amount),0) v FROM payouts').v;
    const owed=one("SELECT COALESCE(SUM(payout),0) v FROM scans WHERE verified=1 AND engine!='demo'").v-paid;
    r.json({revenue:rev.v,orders:rev.n,paidOut:paid,owed:+owed.toFixed(2),
      queue:one("SELECT COUNT(*) n FROM scans WHERE verified=0 AND engine!='demo'").n,
      flags:all("SELECT flags,COUNT(*) n FROM scans WHERE flags!='' AND engine!='demo' GROUP BY flags ORDER BY n DESC LIMIT 10"),
      rejected:one("SELECT COUNT(*) n FROM scans WHERE verified=-1").n,
      paused:setting('payouts_paused')==='1',dailyCap:Number(setting('daily_cap')||process.env.DAILY_PAYOUT_CAP||200),econ:econ(),
      paidToday:one("SELECT COALESCE(SUM(amount),0) v FROM payouts WHERE ts>datetime('now','start of day')").v,
      over600:all("SELECT u.name,SUM(p.amount) t FROM payouts p JOIN users u ON u.id=p.user_id WHERE p.ts>=strftime('%Y-01-01','now') GROUP BY u.id HAVING t>=500"),
      leads:all('SELECT name,email,org,interest,msg,ts FROM leads ORDER BY id DESC LIMIT 25'),
      outbox:all('SELECT to_addr,subject,ts FROM outbox ORDER BY id DESC LIMIT 10')})});
  app.post('/api/admin/bonus',admin,(q,r)=>r.json(runBonus(q.body.month)));
  app.get('/api/admin/queue',admin,(q,r)=>r.json(all("SELECT s.id,u.name,s.ts,s.city,s.brand,s.kind,s.payout,s.flags,s.engine FROM scans s JOIN users u ON u.id=s.user_id WHERE s.verified=0 AND s.engine!='demo' ORDER BY s.id LIMIT 100")));
  app.post('/api/admin/review',admin,(q,r)=>{const ids=(q.body.ids||[]).map(Number);const v=q.body.approve?1:-1;
    ids.forEach(i=>run('UPDATE scans SET verified=?,payout=CASE WHEN ?=-1 THEN 0 ELSE payout END WHERE id=?',[v,v,i]));r.json({ok:1,n:ids.length})});
  app.post('/api/admin/settings',admin,(q,r)=>{if('paused' in q.body)setting('payouts_paused',q.body.paused?1:0);if(q.body.dailyCap)setting('daily_cap',Number(q.body.dailyCap));if(q.body.share!=null)setting('rev_share_pct',Math.max(0,Math.min(95,Number(q.body.share))));if('auto' in q.body)setting('auto_scale',q.body.auto?1:0);
    if(Array.isArray(q.body.tiers))setting('tiers',JSON.stringify(q.body.tiers.map(t=>({min:+t.min,branded:+t.branded,unread:+t.unread,cap:+t.cap})).sort((a,b)=>a.min-b.min)));r.json({ok:1})});
  app.post('/api/admin/apikey',admin,(q,r)=>{const k='bt_'+require('crypto').randomBytes(18).toString('hex');run("INSERT INTO apikeys VALUES(?,?,datetime('now'))",[k,q.body.buyer||'manual']);r.json({key:k})});
  app.get('/api/v1/export.csv',(q,r)=>{const k=q.query.key||(q.get('authorization')||'').replace('Bearer ','');
    if(!one('SELECT key FROM apikeys WHERE key=?',[k]))return r.status(401).send('invalid API key');
    const rows=all("SELECT ts AS utc,ROUND(lat,3) lat,ROUND(lng,3) lng,city,COALESCE(brand,'') brand,kind,engine='demo' AS demo FROM scans WHERE verified>=0 AND kind!='none' ORDER BY id DESC LIMIT 50000");
    r.type('text/csv').send('utc,lat,lng,city,brand,kind,demo\n'+rows.map(x=>[x.utc,x.lat,x.lng,x.city,x.brand,x.kind,x.demo].map(v=>/[,"]/.test(v)?`"${String(v).replace(/"/g,'""')}"`:v).join(',')).join('\n'))});
};
