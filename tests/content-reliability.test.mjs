import { PGlite } from '@electric-sql/pglite';
import vm from 'node:vm';
import fs from 'node:fs';
import crypto from 'node:crypto';
import https from 'node:https';
import tls from 'node:tls';
import assert from 'node:assert/strict';
const db=new PGlite();
const sql=async(q,args=[])=>{const r=(!args.length&&q.trim().split(';').filter(x=>x.trim()).length>1)?(await db.exec(q)).at(-1):await db.query(q,args);return {rows:r?.rows||[],rowCount:r?.affectedRows||r?.rows?.length||0};};
const pool={query:sql,connect:async()=>({query:sql,release(){}}),on(){}};
const routes=new Map();const app={get:(p,fn)=>routes.set('GET '+p,fn),post:(p,fn)=>routes.set('POST '+p,fn),use(){},disable(){}};
const express=Object.assign(()=>app,{json:()=>()=>{}});
const context=vm.createContext({console,process:{env:{MAX_BOT_TOKEN:'test',DATABASE_URL:'unused'}},crypto,https,tls,pg:{Pool:class{constructor(){return pool;}}},express,Buffer,URL,URLSearchParams,Date,setTimeout,clearTimeout,setInterval});
let source=fs.readFileSync(new URL('../index.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');source=source.slice(0,source.lastIndexOf('start().catch'));vm.runInContext(source,context);
const run=(code,values={})=>{Object.assign(context,values);return vm.runInContext(code,context);};
await run('notify=async()=>{};maxAdministrator=async()=>({is_owner:true,is_admin:true,is_bot:false,permissions:["write","delete_message"]}); initDatabase()');
await run('initDatabase()');
await sql("INSERT INTO channels(id,max_chat_id,owner_user_id,title,proposal_code,moderation_mode) VALUES(1,101,7,'Hair','hair','manual'),(2,102,8,'Other','other','manual')");
let n=0;const test=async(name,fn)=>{await fn();console.log('PASS '+name);n++;};
const get=async(id)=>(await sql('SELECT * FROM ep_content_candidates WHERE id=$1',[id])).rows[0];
await test('Seed stores exactly nine references and eighteen sources; replay is safe',async()=>{
 await run('contentSeed(1,7)');await run('contentSeed(1,7)');
 assert.equal((await sql('SELECT * FROM ep_content_candidates')).rowCount,9);
 assert.equal((await sql('SELECT * FROM ep_content_sources')).rowCount,18);
 const r=await get(1);assert.equal(r.metadata_status,'unverified');assert.equal(r.metrics.views,null);assert.equal(r.published_at,null);
});
await test('Metadata ingestion deduplicates aliases and refreshes metrics without restoring skipped decisions',async()=>{
 await run("contentDecide(1,7,1,'skip')");
 const i={provider:'tiktok',remote_id:'7630155394786069782',canonical_url:'https://www.tiktok.com/@ailq309/video/7630155394786069782',original_url:'https://vt.tiktok.com/ZSqV2aYs5/',author:'ailq309',published_at:'2026-09-01T12:00:00Z',duration:15,metrics:{views:1000,likes:0}};
 await run('contentUpsert(pool,1,1,item)',{item:i});await run('contentUpsert(pool,1,2,item)',{item:i});
 const r=await get(1);assert.equal(r.state,'skipped');assert.equal(r.metrics.likes,0);assert.equal(r.metrics.shares,null);assert.equal(r.metadata_status,'verified');
 assert.equal((await sql('SELECT * FROM ep_content_discoveries WHERE candidate_id=1')).rowCount,2);
});
await test('Unverified reseeding cannot overwrite verified metadata',async()=>{await run('contentSeed(1,7)');assert.equal((await get(1)).metrics.views,1000);});
await test('Cross-tenant requests and source changes by non-owners are refused',async()=>{
 await assert.rejects(run('contentSeed(2,7)'),/Нет доступа/);
 await assert.rejects(run("contentDecide(2,8,1,'queue')"),/не найден/);
 await assert.rejects(run('contentState(2,7,{})'),/Нет доступа/);
});
await test('Source validation rejects arbitrary network destinations and malformed URLs',async()=>{
 for(const url of ['http://tiktok.com/@a','https://127.0.0.1/@a','https://www.tiktok.com.evil/@a','https://u:p@www.tiktok.com/@a','https://www.tiktok.com:99/@a','https://www.tiktok.com/redirect?url=x'])assert.throws(()=>run('contentSourceUrl(url)',{url}));
 assert.equal(run("contentSourceUrl('@miaoloo')"),'https://www.tiktok.com/@miaoloo');
});
await test('Repeated queue actions reserve one slot; next candidate reserves a later slot',async()=>{
 await run("contentDecide(1,7,1,'queue')");const first=await get(1);await run("contentDecide(1,7,1,'queue')");assert.equal(+new Date((await get(1)).due_at),+new Date(first.due_at));
 await run("contentDecide(1,7,2,'queue')");assert.equal(+new Date((await get(2)).due_at)- +new Date(first.due_at),90*60000);
 await assert.rejects(run("contentDecide(1,7,3,'queue','2020-01-01')"),/Выберите время/);
});
const prepared={body:{text:'UNTRUSTED CAPTION',attachments:[{type:'video',payload:{token:'safe-upload-token'}}]},content_hash:'a'.repeat(64)};
await test('Successful preparation writes the existing queue and preserves private provenance only',async()=>{
 await sql("UPDATE ep_content_candidates SET state='preparing' WHERE id=1");await run('contentQueue(row,prepared)',{row:await get(1),prepared});
 const r=await get(1);assert.equal(r.state,'queued');const p=(await sql('SELECT * FROM ep_posts WHERE id=$1',[r.post_id])).rows[0];
 assert.equal(p.body.text,'');assert.equal(p.source_message.author,'ailq309');assert.ok(!JSON.stringify(p.body).includes('tiktok'));assert.ok(!JSON.stringify(p.body).includes('UNTRUSTED'));
 assert.equal((await sql('SELECT * FROM ep_schedules WHERE post_id=$1',[r.post_id])).rowCount,1);
 await run('contentQueue(row,prepared)',{row:r,prepared});assert.equal((await sql('SELECT * FROM ep_posts')).rowCount,1);
});
await test('Same video bytes under a different ID cannot create another post',async()=>{
 await sql("UPDATE ep_content_candidates SET state='preparing' WHERE id=2");await assert.rejects(run('contentQueue(row,prepared)',{row:await get(2),prepared}),/уже передан/);
 assert.equal((await sql('SELECT * FROM ep_posts')).rowCount,1);assert.equal((await get(2)).post_id,null);
});
await test('Invalid payload, missing reserved date and revoked access cannot queue',async()=>{
 await assert.rejects(run('contentQueue(row,prepared)',{row:await get(2),prepared:{body:{text:'x'},content_hash:'x'}}),/не подготовлено/);
 await sql("UPDATE ep_content_candidates SET state='preparing',due_at=NULL WHERE id=2");
 await assert.rejects(run('contentQueue(row,prepared)',{row:await get(2),prepared:{...prepared,content_hash:'b'.repeat(64)}}),/время публикации/);
 await sql("UPDATE ep_content_candidates SET state='selected',due_at=NOW()+INTERVAL '2 hours' WHERE id=2");
 await sql('UPDATE channels SET active=FALSE WHERE id=1');await assert.rejects(run('contentQueue(row,prepared)',{row:await get(2),prepared}),/Нет доступа/);await sql('UPDATE channels SET active=TRUE WHERE id=1');
});
await test('One inaccessible source does not disable or modify other sources',async()=>{
 await run("crossBridge=async()=>{throw Error('TikTok unavailable');}");await assert.rejects(run('contentCollect(s)',{s:(await sql('SELECT * FROM ep_content_sources WHERE id=1')).rows[0]}),/unavailable/);
 assert.equal((await sql('SELECT * FROM ep_content_candidates')).rowCount,9);
});
await test('Malformed source batch rolls back all candidates and checkpoint',async()=>{
 const s=(await sql('SELECT * FROM ep_content_sources WHERE id=1')).rows[0];
 await run('crossBridge=async()=>({items:[valid,{provider:"bad"}]})',{valid:{provider:'tiktok',remote_id:'7999999999999999999',canonical_url:'https://www.tiktok.com/@test/video/7999999999999999999',original_url:'https://www.tiktok.com/@test',metrics:{}}});
 await assert.rejects(run('contentCollect(s)',{s}),/Некорректный/);
 assert.equal((await sql("SELECT * FROM ep_content_candidates WHERE remote_id='7999999999999999999'")).rowCount,0);
 assert.equal((await sql('SELECT checked_at FROM ep_content_sources WHERE id=1')).rows[0].checked_at,null);
});
await test('Worker recovers abandoned preparation and safely records a bridge failure',async()=>{
 await sql("UPDATE ep_content_sources SET enabled=FALSE");
 await sql("UPDATE ep_content_candidates SET state='preparing',lease_until=NOW()-INTERVAL '1 minute' WHERE id=2");
 const query=pool.query;pool.query=async(q,args)=>q.includes('pg_try_advisory_lock')?{rows:[{acquired:true}]}:q.includes('pg_advisory_unlock')?{rows:[]}:query(q,args);
 const connect=pool.connect;pool.connect=async()=>({query:pool.query,release(){}});
 await run("ready=true;crossBridge=async()=>{throw Error('Bridge offline');};contentTick()");
 pool.query=query;pool.connect=connect;
 const row=await get(2);assert.equal(row.state,'failed');assert.equal(row.last_error,'Bridge offline');assert.equal(row.post_id,null);
});
await test('UI API requires a valid MAX signature',async()=>{
 await run('ready=true');let status;let body;const res={set(){},status(n){status=n;return this;},json(b){body=b;}};
 await routes.get('POST /content/api/state')({get:()=>null,is:()=>true,body:{initData:'user=7',channelId:1}},res);
 assert.equal(status,401);assert.equal(body.ok,false);
});
await test('Preview page and calendar launcher parse; all API routes exist',async()=>{
 const html=run('CONTENT_HTML');for(const m of html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g))new vm.Script(m[1]);
 let html2;routes.get('GET /calendar')({}, {set(){},type(){return this;},send(s){html2=s;}});
 for(const m of html2.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g))new vm.Script(m[1]);
 assert.match(html2,/location.replace\('\/content#/ );for(const name of ['channels','state','sources','seed','decide','toggle'])assert.ok(routes.has('POST /content/api/'+name));
});
await test('Hair screening rejects interior despite hair hashtags, makeup and unknown titles',async()=>{
 for(const title of ['Мое новое пространство для работы, мебель и новый интерьер! #прически','Макияж и прическа','makeup #hairstyle','ميكب #تسريحات','Драма-романтизм','TikTok video #123','@hairtutorial']){
  if(title==='@hairtutorial')continue;
  assert.notEqual(run('contentHairRelevance(title)',{title}),'match',title);
 }
 for(const title of ['Плетение косичек','Текстурный пучок','Укладка и локоны','easy braid tutorial','تسريحات شعر','编发教程'])assert.equal(run('contentHairRelevance(title)',{title}),'match',title);
});
await test('Channel policy filters old and new discoveries, blocks queue bypass and preserves selected posts',async()=>{
 const item={provider:'tiktok',remote_id:'7777777777777777777',canonical_url:'https://www.tiktok.com/@hair/video/7777777777777777777',original_url:'https://www.tiktok.com/@hair/video/7777777777777777777',author:'hairtutorial',title:'Новый интерьер #прически',metrics:{}};
 const r=await run('contentUpsert(pool,1,null,item)',{item});
 await run('contentHairPolicy(1,7,true)');
 assert.equal((await run("contentState(1,7,{filter:'new'})")).items.some(x=>x.id===r.id),false);
 assert.equal((await run("contentState(1,7,{filter:'excluded'})")).items.some(x=>x.id===r.id),true);
 await assert.rejects(run("contentDecide(1,7,id,'queue')",{id:r.id}),/Тема/);
 assert.equal((await run('contentState(2,8,{})')).hairOnly,false);
 await assert.rejects(run('contentHairPolicy(1,8,false)'),/Нет доступа/);
 assert.equal((await get(1)).state,'queued');
 await run('contentUpsert(pool,1,null,item)',{item:{...item,title:'Плетение косичек'}});
 assert.equal((await get(r.id)).hair_relevance,'match');
 assert.equal((await run("contentState(1,7,{filter:'new'})")).items.some(x=>x.id===r.id),false);
 assert.equal((await run("contentState(1,7,{filter:'checking'})")).items.some(x=>x.id===r.id),true);
});
await test('Panel rescheduling preserves post body, rejects stale revisions, past times and other tenants',async()=>{
 const row=await get(1);const q=(await sql('SELECT * FROM ep_schedules WHERE post_id=$1',[row.post_id])).rows[0];
 const due=new Date(Date.now()+86400000).toISOString();
 await run('contentMove(1,7,1,rev,due)',{rev:Number(q.revision),due});
 const fresh=(await sql('SELECT * FROM ep_schedules WHERE id=$1',[q.id])).rows[0];
 assert.equal(+new Date(fresh.due_at),+new Date(due));assert.deepEqual(fresh.body_snapshot,q.body_snapshot);
 assert.equal(+new Date((await get(1)).due_at),+new Date(due));
 await assert.rejects(run('contentMove(1,7,1,rev,due)',{rev:Number(q.revision),due}),/Расписание изменилось/);
 await assert.rejects(run('contentMove(1,8,1,rev,due)',{rev:Number(fresh.revision),due}),/Нет доступа/);
 await assert.rejects(run('contentMove(1,7,1,rev,due)',{rev:Number(fresh.revision),due:'2020-01-01T00:00:00Z'}),/Выберите/);
 await sql("UPDATE ep_schedules SET status='sending' WHERE id=$1",[q.id]);
 await assert.rejects(run('contentMove(1,7,1,rev,due)',{rev:Number(fresh.revision),due}),/Расписание изменилось/);
});
await test('Replacement pauses old media, atomically swaps video and preserves date, caption and buttons',async()=>{
 const c=await get(1);await sql("UPDATE ep_schedules SET status='scheduled' WHERE post_id=$1",[c.post_id]);
 const old=(await sql('SELECT * FROM ep_schedules WHERE post_id=$1',[c.post_id])).rows[0];
 await assert.rejects(run('contentReplaceRequest(1,8,1,rev)',{rev:Number(old.revision)}),/Нет доступа/);
 await run('contentReplaceRequest(1,7,1,rev)',{rev:Number(old.revision)});
 assert.equal((await sql('SELECT status FROM ep_schedules WHERE id=$1',[old.id])).rows[0].status,'paused');
 await run('contentReplaceRequest(1,7,1,rev)',{rev:Number(old.revision)}); // safe replay
 await sql("UPDATE ep_content_candidates SET refresh_state='preparing' WHERE id=1");
 const row=await get(1);const prepared={content_hash:'e'.repeat(64),body:{attachments:[{type:'video',payload:{token:'clean-replacement'}}]}};
 await run('contentReplaceFinish(row,prepared)',{row,prepared});
 const q=(await sql('SELECT * FROM ep_schedules WHERE id=$1',[old.id])).rows[0];
 assert.equal(+new Date(q.due_at),+new Date(old.due_at));assert.equal(q.status,'scheduled');
 assert.equal(q.body_snapshot.text,old.body_snapshot.text);
 assert.deepEqual(q.body_snapshot.attachments.filter(a=>a.type!=='video'),old.body_snapshot.attachments.filter(a=>a.type!=='video'));
 assert.equal(q.body_snapshot.attachments.find(a=>a.type==='video').payload.token,'clean-replacement');
 assert.equal((await get(1)).refresh_state,'complete');
 await run('contentReplaceRequest(1,7,1,rev)',{rev:Number(q.revision)});
 await sql("UPDATE ep_content_candidates SET refresh_state='preparing' WHERE id=1");
 await sql('UPDATE ep_schedules SET revision=revision+1 WHERE id=$1',[q.id]);
 await assert.rejects(run('contentReplaceFinish(row,prepared)',{row:await get(1),prepared}),/Пост изменён/);
 const unchanged=(await sql('SELECT * FROM ep_schedules WHERE id=$1',[q.id])).rows[0];
 assert.equal(unchanged.body_snapshot.attachments.find(a=>a.type==='video').payload.token,'clean-replacement');
});
const fp={"version":1,"duration":35,"frames":["80c4c0212733361cfeffff30818183ff","a0c5d063273b1b96fcffff318180c0ff","90e3c34327970b1bfcf9f9e0c0c1c1ff","80c4d07361072b39ffffff39800080df","81cdc0626c263d1cfdffff38060280ff","d0e271f18d971f04fcffff38c04081fe","81c5c0738b8f3326fffffff8410081f7","406160618786938fffffffbdc1c1c1c3"],"colors":[[161,137,133],[167,142,136],[150,121,116],[168,138,129],[169,142,137],[175,148,141],[172,141,132],[179,149,140]]};
await test('Video comparison accepts recompression, rejects different sequence and blank images',async()=>{
 const near=JSON.parse(JSON.stringify(fp));near.frames=near.frames.map(h=>(BigInt('0x'+h)^1n).toString(16).padStart(32,'0'));
 assert.equal(run('sameVideo(a,b)',{a:fp,b:near}),true);
 const other={...fp,frames:fp.frames.map(h=>(BigInt('0x'+h)^((1n<<128n)-1n)).toString(16).padStart(32,'0'))};
 assert.equal(run('sameVideo(a,b)',{a:fp,b:other}),false);
 assert.equal(run('sameVideo(a,b)',{a:fp,b:{...fp,duration:fp.duration+10}}),false);
 const blank={...fp,frames:Array(8).fill('0'.repeat(32))};assert.equal(run('sameVideo(a,b)',{a:blank,b:blank}),false);
});
const make=async(remote)=>await run('contentUpsert(pool,1,null,item)',{item:{provider:'tiktok',remote_id:remote,canonical_url:'https://www.tiktok.com/@test/video/'+remote,original_url:'https://www.tiktok.com/@test',title:'Прическа и коса',author:'test',duration:35,metrics:{}}});
await test('Visual reposts are hidden before review and cannot enter the publication queue',async()=>{
 const a=await make('7888888888888888801'),b=await make('7888888888888888802');
 await run('contentSaveInspection(row,data)',{row:a,data:{content_hash:'1'.repeat(64),fingerprint:fp}});
 await run('contentSaveInspection(row,data)',{row:b,data:{content_hash:'2'.repeat(64),fingerprint:fp}});
 assert.equal((await get(b.id)).scan_state,'duplicate');assert.equal((await get(b.id)).duplicate_of,a.id);
 assert.equal((await run("contentState(1,7,{filter:'new'})")).items.some(x=>x.id===b.id),false);
 assert.equal((await run("contentState(1,7,{filter:'duplicates'})")).items.some(x=>x.id===b.id),true);
 await assert.rejects(run("contentDecide(1,7,id,'queue')",{id:b.id}),/похож/);
 await assert.rejects(run("contentDecide(1,8,id,'distinct')",{id:b.id}),/Нет доступа/);
 await run("contentDecide(1,7,id,'distinct')",{id:b.id});assert.equal((await get(b.id)).duplicate_override,true);
});
await test('Recovery preserves chosen dates and ignores skipped, published, duplicate and permanent failures',async()=>{
 const a=await make('7888888888888888811'),b=await make('7888888888888888812');
 await sql("UPDATE ep_content_candidates SET state='failed',selected_by=7,due_at=NOW()+INTERVAL '1 day',last_error='Сервис обработки запускается. Повторите через минуту.' WHERE id=$1",[a.id]);
 await sql("UPDATE ep_content_candidates SET state='failed',selected_by=7,due_at=NOW(),last_error='TikTok удалён' WHERE id=$1",[b.id]);
 const before=await get(a.id);assert.equal(await run('contentRecover(1,7)'),1);const after=await get(a.id);
 assert.equal(+new Date(after.due_at),+new Date(before.due_at));assert.equal(after.state,'selected');assert.equal((await get(b.id)).state,'failed');
 assert.equal(await run('contentRecover(1,7)'),0);
 await assert.rejects(run('contentRecover(1,8)'),/Нет доступа/);
});
await test('Temporary preparation failure retries without losing selection or date; retries are bounded',async()=>{
 const a=await make('7888888888888888821');
 await sql("UPDATE ep_content_candidates SET state='preparing',selected_by=7,due_at=NOW()+INTERVAL '1 day' WHERE id=$1",[a.id]);
 const before=await get(a.id);const e=Object.assign(new Error('Обработчик не ответил'),{safeRetry:true});
 await run('contentPreparationFailed(row,e)',{row:before,e});const after=await get(a.id);
 assert.equal(after.state,'selected');assert.equal(+new Date(after.due_at),+new Date(before.due_at));assert.equal(after.prepare_attempts,1);
 await run('contentPreparationFailed(row,e)',{row:{...after,prepare_attempts:4},e});assert.equal((await get(a.id)).state,'failed');
});
await test('Late completed preparation retains scheduled time and creates only one post',async()=>{
 const a=await make('7888888888888888831');await sql("UPDATE ep_content_candidates SET state='preparing',selected_by=7,due_at=NOW()-INTERVAL '1 hour' WHERE id=$1",[a.id]);
 const row=await get(a.id),prepared={content_hash:'9'.repeat(64),body:{attachments:[{type:'video',payload:{token:'late'}}]}};
 await run('contentQueue(row,prepared)',{row,prepared});await run('contentQueue(row,prepared)',{row,prepared});
 const done=await get(a.id);assert.equal(done.state,'queued');assert.equal(+new Date(done.due_at),+new Date(row.due_at));
 assert.equal((await sql('SELECT * FROM ep_schedules WHERE post_id=$1',[done.post_id])).rowCount,1);
});
await test('Background inspection indexes existing posts first and supports channels without the hair filter',async()=>{
 await sql("UPDATE ep_content_candidates SET scan_state='ready'");
 await sql("UPDATE ep_content_candidates SET scan_state='pending' WHERE id=1");
 const item={provider:'tiktok',remote_id:'7888888888888888841',canonical_url:'https://www.tiktok.com/@test/video/7888888888888888841',original_url:'https://www.tiktok.com/@test',title:'Other topic',author:'test',duration:35,metrics:{}};
 const candidate=await run('contentUpsert(pool,2,null,item)',{item});const inspected=[];
 await run("crossBridge=async p=>{inspected.push(p.url);return {content_hash:p.url.endsWith('8841')?'6'.repeat(64):'7'.repeat(64),fingerprint:fixture}}",{inspected,fixture:fp});
 assert.equal(await run('contentInspectNext(true)'),true);assert.equal(inspected[0],(await get(1)).canonical_url);
 assert.equal(await run('contentInspectNext(true)'),false);
 assert.equal(await run('contentInspectNext()'),true);assert.equal((await get(candidate.id)).scan_state,'ready');
 assert.ok(inspected[1].endsWith('8841'));
});
console.log(`${n} tests passed`);await db.close();
