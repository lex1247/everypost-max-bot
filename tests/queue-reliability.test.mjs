import { PGlite } from '@electric-sql/pglite';
import vm from 'node:vm';
import fs from 'node:fs';
import crypto from 'node:crypto';
import https from 'node:https';
import tls from 'node:tls';
import assert from 'node:assert/strict';

const db = new PGlite();
const sql = async (q,args=[]) => {
  if (!args.length && q.trim().split(';').filter(x=>x.trim()).length>1) {
    const results=await db.exec(q);const r=results.at(-1)||{};return {rows:r.rows||[],rowCount:r.affectedRows||r.rows?.length||0};
  }
  const r=await db.query(q,args);return {rows:r.rows||[],rowCount:r.affectedRows||r.rows?.length||0};
};
const pool={query:sql,connect:async()=>({query:sql,release(){}}),on(){}};
const out=[],sent=[],denied=new Set(),failures=new Map();
const app={get(){},post(){},use(){},disable(){}};
const express=Object.assign(()=>app,{json:()=>()=>{}});
const context=vm.createContext({console,process:{env:{MAX_BOT_TOKEN:'test-only',DATABASE_URL:'unused'},exit(){throw Error('unexpected exit');}},
  Date,crypto,https,tls,pg:{Pool:class{constructor(){return pool;}}},express,Buffer,URL,URLSearchParams,setTimeout,clearTimeout,setInterval,
  TEST:{out,sent,denied,failures}});
let source=fs.readFileSync(new URL('../index.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
source=source.slice(0,source.lastIndexOf('start().catch'));
vm.runInContext(source,context);
vm.runInContext(`
  maxAdministrator=async(chat,user)=> TEST.denied.has(String(chat))?null:({is_owner:true,is_admin:true,is_bot:false,permissions:['write','delete_message']});
  notify=async(user,text)=>{TEST.out.push({user,text});};
  sendMessage=async(kind,id,body)=>{TEST.out.push({user:id,body});return {message:{body:{mid:'preview-'+TEST.out.length}}};};
  answerCallback=async()=>{};
  maxRequest=async(path,method,body)=>{
    const chat=new URL('https://test'+path).searchParams.get('chat_id');
    if(TEST.failures.has(chat))throw TEST.failures.get(chat);
    TEST.sent.push({chat,body});return {message:{body:{mid:'published-'+TEST.sent.length},timestamp:Date.now()}};
  };
  safeRememberDiscussion=async()=>{};

`,context);
async function run(code,values={}) {Object.assign(context,values);return vm.runInContext(code,context);}
await run('initDatabase()');
await run('initDatabase()'); // migration rerun leaves existing data intact
await sql(`INSERT INTO channels(id,max_chat_id,owner_user_id,title,proposal_code,moderation_mode)
  VALUES(1,101,7,'Москва','moscow','manual'),(2,102,7,'Сочи','sochi','manual'),(3,103,7,'Арск','arsk','manual')`);
await sql(`UPDATE channels SET post_style=jsonb_build_object('signature_on',TRUE,'proposal_on',TRUE,
  'signature',jsonb_build_object('text',title))`);
let count=0;
async function test(name,fn){await fn();console.log('PASS',name);count++;}
async function draft(ids=[1,2],base={text:'Новость'}) {
  const targets=[];
  for(const id of ids)targets.push(await run(`(async()=>{const c=await getChannel(cid);return {channel_id:String(cid),title:c.title,style:styleForChannel(c)};})()`,{cid:id}));
  const body=await run('composeStyledPost(baseArg,styleArg)',{baseArg:base,styleArg:targets[0].style});
  const p=(await sql(`INSERT INTO ep_posts(channel_id,author_user_id,body,base_body,source_message,post_style,multi_targets,
    preview_mid,controls_mid,is_saved) VALUES($1,7,$2,$3,'{}',$4,$5,'preview','controls',TRUE) RETURNING *`,
    [ids[0],JSON.stringify(body),JSON.stringify(base),JSON.stringify(targets[0].style),JSON.stringify(targets)])).rows[0];
  return p;
}
async function expand(p,due=new Date(Date.now()+60000)) {
  await sql('BEGIN');
  try {await run('expandMultiTargets(pool,postArg,7,dueArg,"Europe/Moscow")',{postArg:p,dueArg:due});await sql('COMMIT');}
  catch(e){await sql('ROLLBACK');throw e;}
}
await test('Different signatures and proposal links; base is unchanged',async()=>{
  const p=await draft();await expand(p);
  const child=(await sql('SELECT * FROM ep_posts WHERE id=(SELECT post_id FROM ep_multi_deliveries WHERE root_post_id=$1 AND channel_id=2)',[p.id])).rows[0];
  assert.equal(child.body.text,'Новость\n\nСочи');assert.equal(p.body.text,'Новость\n\nМосква');
  assert.match(JSON.stringify(child.body),/start=sochi/);assert.doesNotMatch(JSON.stringify(child.body),/start=moscow/);
  assert.equal(child.base_body.text,'Новость');
});
await test('Expansion replay and root rescheduling never recreate children',async()=>{
  const p=await draft();await expand(p);const before=(await sql('SELECT COUNT(*) AS n FROM ep_posts')).rows[0].n;
  const fresh=(await sql('SELECT * FROM ep_posts WHERE id=$1',[p.id])).rows[0];await expand(fresh);
  assert.equal((await sql('SELECT COUNT(*) AS n FROM ep_posts')).rows[0].n,before);
});
await test('Revoked destination is skipped, other destinations remain queued',async()=>{
  const p=await draft([1,2,3]);denied.add('102');await expand(p);denied.clear();
  const rows=(await sql('SELECT * FROM ep_multi_deliveries WHERE root_post_id=$1 ORDER BY channel_id',[p.id])).rows;
  assert.equal(rows[1].post_id,null);assert.match(rows[1].last_error,/отозваны/);assert.ok(rows[2].post_id);
});
await test('Long destination text becomes editable draft, shorter destination proceeds',async()=>{
  const p=await draft([1,2,3],{text:'x'.repeat(3950)});p.multi_targets[1].style.signature={text:'x'.repeat(100)};
  await expand(p);
  const rows=(await sql(`SELECT p.*,d.channel_id FROM ep_multi_deliveries d JOIN ep_posts p ON p.id=d.post_id
    WHERE root_post_id=$1 ORDER BY d.channel_id`,[p.id])).rows;
  assert.equal(rows[1].status,'draft');assert.equal(rows[1].is_saved,true);assert.equal(rows[1].base_body.text,'x'.repeat(3950));
  assert.match(rows[1].last_error,/4000/);assert.equal(rows[2].status,'scheduled');
});
await test('Deletion date copied as an absolute timestamp, never an interval',async()=>{
  const p=await draft(),due=new Date(Date.now()+3600000);
  await sql(`INSERT INTO ep_auto_deletions(target_key,channel_id,capability,due_at,timezone,requested_by,access_version,enabled,status)
    VALUES($1,1,'create',$2,'Europe/Moscow',7,0,TRUE,'armed')`,['p_'+p.id,due]);
  await expand(p);
  const child=(await sql(`SELECT a.* FROM ep_auto_deletions a JOIN ep_multi_deliveries d ON a.target_key='p_'||d.post_id
    WHERE d.root_post_id=$1 AND d.channel_id=2`,[p.id])).rows[0];
  assert.equal(new Date(child.due_at).getTime(),due.getTime());assert.equal(child.status,'armed');assert.equal(child.requested_by,7);
});
await test('Folder ownership and idempotent explicit membership callbacks',async()=>{
  const f=(await sql("INSERT INTO ep_channel_folders(actor_user_id,name) VALUES(7,'Юг') RETURNING *")).rows[0];
  const cb={callback:{user:{user_id:7},payload:`fset_${f.id}_2_1_0`}};
  await run('handleMultiCallback(updateArg)',{updateArg:cb});await run('handleMultiCallback(updateArg)',{updateArg:cb});
  assert.deepEqual((await sql('SELECT channel_ids FROM ep_channel_folders WHERE id=$1',[f.id])).rows[0].channel_ids,['2']);
  cb.callback.user.user_id=8;cb.callback.payload=`fremove_${f.id}`;await run('handleMultiCallback(updateArg)',{updateArg:cb});
  assert.equal((await sql('SELECT id FROM ep_channel_folders WHERE id=$1',[f.id])).rowCount,1);
});
await test('Selection keeps bigint IDs exact and deduplicates overlapping folders',async()=>{
  assert.equal(JSON.stringify(await run('multiIds(["9007199254740993","2","2",null,"bad"])')),'["9007199254740993","2"]');
  await sql("INSERT INTO ep_composer_sessions(actor_user_id,nonce,stage,selected_channels) VALUES(7,$1,'choose_channel','[\"1\"]')",['a'.repeat(24)]);
  let s=(await sql('SELECT * FROM ep_composer_sessions WHERE actor_user_id=7')).rows[0];
  await run('selectMultiChannels(sessionArg,["1","2"],true)',{sessionArg:s});
  const fresh=(await sql('SELECT * FROM ep_composer_sessions WHERE actor_user_id=7')).rows[0];assert.deepEqual(fresh.selected_channels,['1','2']);
  await run('selectMultiChannels(sessionArg,["1"],false)',{sessionArg:s});
  assert.deepEqual((await sql('SELECT selected_channels FROM ep_composer_sessions WHERE actor_user_id=7')).rows[0].selected_channels,['1','2']);
  await sql('DELETE FROM ep_composer_sessions');
});
await test('Immediate queue is transactional and duplicate clicks do not enqueue twice',async()=>{
  const p=await draft(),nonce='b'.repeat(24);
  await sql("INSERT INTO ep_composer_sessions(actor_user_id,post_id,nonce,stage) VALUES(7,$1,$2,'preview')",[p.id,nonce]);
  const s=(await sql('SELECT * FROM ep_composer_sessions WHERE actor_user_id=7')).rows[0];
  await run('queueMultiNow(sessionArg,postArg,"cb")',{sessionArg:s,postArg:p});
  await run('queueMultiNow(sessionArg,postArg,"cb")',{sessionArg:s,postArg:p});
  assert.equal((await sql('SELECT * FROM ep_multi_deliveries WHERE root_post_id=$1',[p.id])).rowCount,2);
  assert.equal((await sql('SELECT * FROM ep_composer_sessions WHERE actor_user_id=7')).rowCount,0);
});
await test('Calendar save atomically schedules all destinations and receipt replay is safe',async()=>{
  const p=await draft(),nonce='c'.repeat(24),now=new Date(Date.now()+3600000);
  const choice=await run('localParts(instantArg,"Europe/Moscow")',{instantArg:now});
  await sql(`INSERT INTO ep_schedule_sessions(actor_user_id,post_id,nonce,draft_revision,access_version,timezone,day_key,month_key,hour,minute)
    VALUES(7,$1,$2,0,0,'Europe/Moscow','20260913','202609',1,0)`,[p.id,nonce]);
  const day=await run('dateKey(partsArg)',{partsArg:choice});
  const result=await run('saveCalendarChoice(pool,7,nonceArg,inputArg)',{nonceArg:nonce,inputArg:{day,hour:choice.hour,minute:choice.minute}});
  assert.equal(result.multiCount,2);
  const rows=(await sql(`SELECT q.* FROM ep_multi_deliveries d JOIN ep_schedules q ON q.post_id=d.post_id WHERE d.root_post_id=$1`,[p.id])).rows;
  assert.equal(rows.length,2);assert.equal(new Date(rows[0].due_at).getTime(),new Date(rows[1].due_at).getTime());
  const again=await run('saveCalendarChoice(pool,7,nonceArg,inputArg)');assert.equal(again.replayed,true);
  assert.equal((await sql('SELECT * FROM ep_multi_deliveries WHERE root_post_id=$1',[p.id])).rowCount,2);
});
await test('Worker partial failure cannot republish a successful destination',async()=>{
  await sql("UPDATE ep_schedules SET status='cancelled'");await sql('DELETE FROM ep_webhook_jobs');
  const p=await draft([1,2,3]),nonce='d'.repeat(24);
  await sql("INSERT INTO ep_composer_sessions(actor_user_id,post_id,nonce,stage) VALUES(7,$1,$2,'preview')",[p.id,nonce]);
  const s=(await sql('SELECT * FROM ep_composer_sessions WHERE actor_user_id=7')).rows[0];
  await run('queueMultiNow(sessionArg,postArg,"cb")',{sessionArg:s,postArg:p});
  const err=new Error('MAX rejects destination');err.status=403;failures.set('102',err);
  const offset=sent.length;
  for(let i=0;i<5;i++)await run('processOneScheduled()');failures.clear();
  assert.deepEqual(sent.slice(offset).map(x=>x.chat),['101','103']);
  const rows=(await sql(`SELECT q.status FROM ep_multi_deliveries d JOIN ep_schedules q ON q.post_id=d.post_id WHERE root_post_id=$1 ORDER BY d.channel_id`,[p.id])).rows;
  assert.deepEqual(rows.map(x=>x.status),['published','paused','published']);
});
await test('Deletion before publication rolls back the whole batch',async()=>{
  await sql('DELETE FROM ep_composer_sessions');
  const p=await draft(),nonce='e'.repeat(24);
  await sql("INSERT INTO ep_composer_sessions(actor_user_id,post_id,nonce,stage) VALUES(7,$1,$2,'preview')",[p.id,nonce]);
  await sql(`INSERT INTO ep_auto_deletions(target_key,channel_id,capability,due_at,timezone,requested_by,access_version,enabled,status)
    VALUES($1,1,'create',NOW()-INTERVAL '1 minute','Europe/Moscow',7,0,TRUE,'armed')`,['p_'+p.id]);
  const session=(await sql('SELECT * FROM ep_composer_sessions WHERE actor_user_id=7')).rows[0];
  await assert.rejects(run('queueMultiNow(sessionArg,postArg,"cb")',{sessionArg:session,postArg:p}));
  assert.equal((await sql('SELECT * FROM ep_multi_deliveries WHERE root_post_id=$1',[p.id])).rows.length,0);
  assert.equal((await sql('SELECT * FROM ep_schedules WHERE post_id=$1',[p.id])).rows.length,0);
  assert.equal((await sql('SELECT status FROM ep_posts WHERE id=$1',[p.id])).rows[0].status,'draft');
  await sql('DELETE FROM ep_composer_sessions');
});
await test('Uncertain MAX response is held for inspection and never retried automatically',async()=>{
  await sql("UPDATE ep_schedules SET status='cancelled'");
  const p=await draft([1,2,3]),nonce='f'.repeat(24);
  await sql("INSERT INTO ep_composer_sessions(actor_user_id,post_id,nonce,stage) VALUES(7,$1,$2,'preview')",[p.id,nonce]);
  const session=(await sql('SELECT * FROM ep_composer_sessions WHERE actor_user_id=7')).rows[0];
  await run('queueMultiNow(sessionArg,postArg,"cb")',{sessionArg:session,postArg:p});
  failures.set('102',new Error('Connection lost after request'));
  const offset=sent.length;
  for(let i=0;i<5;i++)await run('processOneScheduled()');
  failures.clear();
  for(let i=0;i<3;i++)await run('processOneScheduled()');
  assert.deepEqual(sent.slice(offset).map(x=>x.chat),['101','103']);
  const rows=(await sql(`SELECT q.status FROM ep_multi_deliveries d JOIN ep_schedules q ON q.post_id=d.post_id WHERE root_post_id=$1 ORDER BY d.channel_id`,[p.id])).rows;
  assert.deepEqual(rows.map(x=>x.status),['published','needs_check','published']);
});
await test('A single selected channel remains a normal post; repeated Continue creates no copy',async()=>{
  const nonce='1'.repeat(24);
  await sql("INSERT INTO ep_composer_sessions(actor_user_id,nonce,stage,selected_channels) VALUES(7,$1,'choose_channel','[\"1\"]')",[nonce]);
  const session=(await sql('SELECT * FROM ep_composer_sessions WHERE actor_user_id=7')).rows[0];
  const n=(await sql('SELECT COUNT(*) AS n FROM ep_posts')).rows[0].n;
  await run('chooseMultipleChannels(sessionArg)',{sessionArg:session});
  await run('chooseMultipleChannels(sessionArg)',{sessionArg:session});
  assert.equal((await sql('SELECT COUNT(*) AS n FROM ep_posts')).rows[0].n,n+1);
  const current=(await sql('SELECT * FROM ep_composer_sessions WHERE actor_user_id=7')).rows[0];
  assert.equal(current.stage,'waiting_content');
  assert.deepEqual((await sql('SELECT multi_targets FROM ep_posts WHERE id=$1',[current.post_id])).rows[0].multi_targets,[]);
});
await sql('DELETE FROM ep_composer_sessions');
await run(`crossBridge=async(p)=> {
 if(p.action==='resolve')return {source:'adlersearch',peer:'-1009',title:'Источник',cursor:50};
 if(p.action==='fetch')return TEST.fetch||{posts:[],cursor:p.cursor};
 if(TEST.prepareError)throw TEST.prepareError;
 return {body:{text:p.text}};
}; ready=true;`);
async function route(){return (await sql("SELECT * FROM ep_cross_routes ORDER BY id LIMIT 1")).rows[0];}
async function item(remote=51,text='Новый материал'){
 const r=await route();return (await sql(`INSERT INTO ep_cross_items(route_id,remote,original,url,media,mode)
  VALUES($1,$2,$3,'https://t.me/adlersearch/51','{}','original') RETURNING *`,[r.id,remote,text])).rows[0];
}
await test('MAX source input creates a paused route and skips historical posts',async()=>{
 await sql("INSERT INTO ep_cross_inputs(actor_user_id,channel_id,nonce) VALUES(7,1,'first')");
 await run('handleCrossMessage(msgArg)',{msgArg:{sender:{user_id:7},body:{mid:'source-input',text:'https://t.me/adlersearch'}}});
 const r=await route();assert.equal(r.enabled,false);assert.equal(r.cursor,50);assert.equal(r.source,'adlersearch');
 assert.equal((await sql('SELECT * FROM ep_cross_inputs')).rows.length,0);
 assert.equal((await sql("SELECT handled FROM ep_command_inputs WHERE max_message_id='source-input'")).rows[0].handled,true);
});
await test('Crosspost ownership cannot be bypassed with foreign callback',async()=>{
 const r=await route();assert.equal(await run('crossRoute(idArg,8)',{idArg:r.id}),null);
 await run('handleCrossCallback(cbArg)',{cbArg:{callback:{user:{user_id:8},payload:`xe_${r.id}_0_1`}}});
 assert.equal((await route()).enabled,false);
});
await test('Enable and mode controls reject stale repeated clicks',async()=>{
 const r=await route();const cb={callback:{user:{user_id:7},payload:`xe_${r.id}_0_1`}};
 await run('handleCrossCallback(cbArg)',{cbArg:cb});await run('handleCrossCallback(cbArg)',{cbArg:cb});
 assert.equal((await route()).revision,1);assert.equal((await route()).enabled,true);
 cb.callback.payload=`xm_${r.id}_0_ai`;await run('handleCrossCallback(cbArg)',{cbArg:cb});assert.equal((await route()).mode,'original');
});
await test('Prepared material uses destination style and queues exactly once',async()=>{
 const r=await route(),i=await item();
 await run('queueCrossItem(itemArg,routeArg,{text:"Новый материал"})',{itemArg:i,routeArg:r});
 await run('queueCrossItem(itemArg,routeArg,{text:"Новый материал"})');
 const x=(await sql('SELECT * FROM ep_cross_items WHERE id=$1',[i.id])).rows[0];
 const p=(await sql('SELECT * FROM ep_posts WHERE id=$1',[x.post_id])).rows[0];
 assert.equal(p.body.text,'Новый материал\n\nМосква');assert.equal(p.source_message.original,'Новый материал');
 assert.equal((await sql('SELECT * FROM ep_schedules WHERE post_id=$1',[p.id])).rows.length,1);
});
await test('Pause during remote preparation prevents subsequent enqueue',async()=>{
 const r=await route(),i=await item(52);
 await sql('UPDATE ep_cross_routes SET enabled=FALSE,revision=revision+1 WHERE id=$1',[r.id]);
 await run('queueCrossItem(itemArg,routeArg,{text:"Новость"})',{itemArg:i,routeArg:r});
 assert.equal((await sql('SELECT post_id FROM ep_cross_items WHERE id=$1',[i.id])).rows[0].post_id,null);
 await sql('UPDATE ep_cross_routes SET enabled=TRUE,revision=revision+1 WHERE id=$1',[r.id]);
});
await test('Oversized styled material stays whole in an editable draft',async()=>{
 const r=await route(),i=await item(53,'x'.repeat(3998));
 await run('queueCrossItem(itemArg,routeArg,baseArg)',{itemArg:i,routeArg:r,baseArg:{text:'x'.repeat(3998)}});
 const p=(await sql('SELECT p.* FROM ep_posts p JOIN ep_cross_items i ON i.post_id=p.id WHERE i.id=$1',[i.id])).rows[0];
 assert.equal(p.status,'draft');assert.equal(p.base_body.text.length,3998);
 assert.equal((await sql('SELECT * FROM ep_schedules WHERE post_id=$1',[p.id])).rows.length,0);
});
await test('Permanent preparation errors retain source text and cannot create a publication',async()=>{
 const i=(await sql("SELECT * FROM ep_cross_items WHERE state='pending' ORDER BY id LIMIT 1")).rows[0];
 context.TEST.prepareError=Object.assign(new Error('Unsupported video'),{permanent:true});
 await run('crossTick()');delete context.TEST.prepareError;
 const fresh=(await sql('SELECT * FROM ep_cross_items WHERE id=$1',[i.id])).rows[0];
 assert.equal(fresh.state,'failed');assert.equal(fresh.post_id,null);assert.equal(fresh.original,i.original);
});
await test('Source collection stores items and cursor atomically, repeats deduplicate',async()=>{
 const r=await route();context.TEST.fetch={posts:[[54,'Fresh','https://t.me/adlersearch/54',{}]],cursor:54};
 await sql('UPDATE ep_cross_routes SET next_at=NOW() WHERE id=$1',[r.id]);await run('crossTick()');
 assert.equal((await route()).cursor,54);
 assert.equal((await sql('SELECT * FROM ep_cross_items WHERE route_id=$1 AND remote=54',[r.id])).rows.length,1);
 delete context.TEST.fetch;
});
await test('An already configured Telegram route is detected before enabling MAX duplication',async()=>{
 await sql(`CREATE SCHEMA repost_bot; CREATE TABLE repost_bot.sources(id BIGINT,platform TEXT,remote TEXT);
 CREATE TABLE repost_bot.destinations(id BIGINT,platform TEXT,remote TEXT);
 CREATE TABLE repost_bot.routes(source BIGINT,destination BIGINT);
 INSERT INTO repost_bot.sources VALUES(1,'tg','-1009'); INSERT INTO repost_bot.destinations VALUES(2,'max','101');
 INSERT INTO repost_bot.routes VALUES(1,2);`);
 const r=await route();assert.equal(await run('crossLegacyDuplicate(routeArg)',{routeArg:r}),true);
 await sql('UPDATE ep_cross_routes SET enabled=FALSE,revision=revision+1 WHERE id=$1',[r.id]);
 const fresh=await route();await run('handleCrossCallback(cbArg)',{cbArg:{callback:{user:{user_id:7},payload:`xe_${r.id}_${fresh.revision}_1`}}});
 assert.equal((await route()).enabled,false);
});
await test('Unsupported source links cannot reach the bridge',async()=>{
 for(const input of ['https://evil.example/source','https://t.me/name/1','https://t.me/+private','https://t.me/source?x=1']){
   assert.throws(()=>vm.runInContext('crossUsername(inputArg)',Object.assign(context,{inputArg:input})));
 }
});
await run(`crossBridge=async(p)=>{
 if(p.action==='trustat_resolve')return {source:'trustat_2159108162',peer:'-1002159108162',title:'Trustat source',cursor:90};
 if(p.action==='trustat_fetch'){if(TEST.fetchError)throw TEST.fetchError;return TEST.fetch||{posts:[],cursor:p.cursor};}
 if(p.action==='prepare')return {body:{text:p.text}};
 throw Error('Unexpected action');
};`);
async function tr(){return (await sql("SELECT * FROM ep_cross_routes WHERE peer='-1002159108162'")).rows[0];}
async function form(){await sql("INSERT INTO ep_cross_inputs(actor_user_id,channel_id,nonce,source_kind) VALUES(7,2,'trustat-input','trustat') ON CONFLICT(actor_user_id) DO UPDATE SET nonce='trustat-input',source_kind='trustat'");}
async function connectTrustat(mid){await run('handleCrossMessage(msgArg)',{msgArg:{sender:{user_id:7},body:{mid,text:'https://t.me/+abcdefgh123'}}});}
await test('Migration preserves existing public routes and private input creates paused Trustat route',async()=>{
 assert.equal((await route()).source_kind,'public');
 await run('handleCrossCallback(cbArg)',{cbArg:{callback:{user:{user_id:7},payload:'xd_2'}}});
 assert.equal((await sql('SELECT * FROM ep_cross_inputs WHERE actor_user_id=7')).rows[0].source_kind,'trustat');
 await connectTrustat('trustat-source-1');
 const r=await tr();assert.equal(r.enabled,false);assert.equal(r.cursor,90);assert.equal(r.source_kind,'trustat');
 assert.equal(r.source,'trustat_2159108162');
});
await test('Quota pauses route without discarding cursor or stored material',async()=>{
 const r=await tr();await sql('UPDATE ep_cross_routes SET enabled=TRUE,next_at=NOW() WHERE id=$1',[r.id]);
 context.TEST.fetchError=Object.assign(Error('Quota exhausted'),{pause:true});
 await run('crossTick()');delete context.TEST.fetchError;
 const fresh=await tr();assert.equal(fresh.enabled,false);assert.equal(fresh.cursor,90);assert.equal(fresh.revision,r.revision+1);
});
await test('Partial quota batch commits material and cursor with pause atomically',async()=>{
 const r=await tr();await sql('UPDATE ep_cross_routes SET enabled=TRUE,next_at=NOW() WHERE id=$1',[r.id]);
 context.TEST.fetch={posts:[[91,'Photo caption','ignored',{photos:[],unsupported:['video']}]],cursor:91,pause:true,message:'Quota exhausted'};
 await run('crossTick()');delete context.TEST.fetch;
 assert.equal((await tr()).cursor,91);assert.equal((await tr()).enabled,false);
 const items=(await sql('SELECT * FROM ep_cross_items WHERE route_id=$1',[r.id])).rows;
 assert.equal(items.length,1);assert.equal(items[0].url,'https://t.me/c/2159108162/91');assert.equal(items[0].post_id,null);
});
await test('Malformed batch rolls back inserts and cursor together',async()=>{
 const r=await tr();await sql('UPDATE ep_cross_routes SET enabled=TRUE,next_at=NOW() WHERE id=$1',[r.id]);
 await sql("UPDATE ep_cross_items SET next_at=NOW()+INTERVAL '1 hour' WHERE route_id=$1",[r.id]);
 context.TEST.fetch={posts:[[92,'Good','ignored',{}],[93,{},'ignored',{}]],cursor:93};
 await run('crossTick()');delete context.TEST.fetch;
 assert.equal((await tr()).cursor,91);
 assert.equal((await sql('SELECT * FROM ep_cross_items WHERE route_id=$1 AND remote=92',[r.id])).rows.length,0);
});
await test('Changing reader requires pause and preserves already collected cursor',async()=>{
 const r=await tr();await sql("UPDATE ep_cross_routes SET source_kind='public',source='oldname',enabled=TRUE WHERE id=$1",[r.id]);
 await form();await connectTrustat('conversion-denied');
 assert.equal((await tr()).source_kind,'public');
 assert.equal((await sql('SELECT * FROM ep_cross_inputs WHERE actor_user_id=7')).rows.length,1);
 await sql('UPDATE ep_cross_routes SET enabled=FALSE,revision=revision+1 WHERE id=$1',[r.id]);
 await connectTrustat('conversion-ok');
 assert.equal((await tr()).source_kind,'trustat');assert.equal((await tr()).cursor,91);assert.equal((await tr()).enabled,false);
});
await test('Repeated connection does not reset cursor or create duplicate route',async()=>{
 const r=await tr();await form();await connectTrustat('connection-repeat');
 assert.equal((await tr()).id,r.id);assert.equal((await tr()).cursor,91);
});
await test('Transient failure retries while preserving cursor',async()=>{
 const r=await tr();await sql('UPDATE ep_cross_routes SET enabled=TRUE,next_at=NOW() WHERE id=$1',[r.id]);
 context.TEST.fetchError=Error('Temporary outage');await run('crossTick()');delete context.TEST.fetchError;
 assert.equal((await tr()).enabled,true);assert.equal((await tr()).cursor,91);
});

await test('Source filters and literal replacements are deterministic without AI',async()=>{
 const rules=await run('parseEditorialRules(ruleText)',{ruleText:'Искать: школа; город\nИсключить: реклама\nЗаменить: https://old.test => https://new.test\nДубли: да'});
 const apply=async text=>run('applyEditorialRules(textArg,rulesArg)',{textArg:text,rulesArg:rules});
 assert.equal((await apply('ШКОЛА https://old.test')).text,'ШКОЛА https://new.test');
 assert.ok((await apply('город реклама')).skip);assert.ok((await apply('Нет ключевых слов')).skip);
 assert.throws(()=>vm.runInContext('parseEditorialRules("Дубли: наверное")',context));
});
await test('Similar news detection requires meaningful overlap and ignores short greetings',async()=>{
 assert.equal(await run('editorialSimilarity("привет","привет")'),0);
 const original='В городе открыли новую школу для учеников старших классов в понедельник утром возле центрального парка';
 assert.equal(await run('editorialSimilarity(a,a)',{a:original}),1);
 assert.ok(await run('editorialSimilarity(a,b)',{a:original,b:'В городе открыли новую школу для учеников старших классов в понедельник утром возле центрального парка! https://news.test'})>=0.86);
 assert.ok(await run('editorialSimilarity(a,b)',{a:original,b:'В другом регионе началась продажа билетов на музыкальные концерты знаменитых зарубежных артистов в новом театре'})<0.2);
});
await test('Rule editor rejects outsider and preserves rules after invalid input',async()=>{
 const r=await tr();await sql('DELETE FROM ep_editorial_inputs');
 await run('handleEditorialCallback(cbArg)',{cbArg:{callback:{user:{user_id:8},payload:`wr_${r.id}`}}});
 assert.equal((await sql('SELECT * FROM ep_editorial_inputs')).rows.length,0);
 await run('handleEditorialCallback(cbArg)',{cbArg:{callback:{user:{user_id:7},payload:`wr_${r.id}`}}});
 await run('handleEditorialMessage(msgArg)',{msgArg:{sender:{user_id:7},body:{mid:'rule-invalid',text:'неверные настройки'}}});
 assert.equal((await sql('SELECT * FROM ep_editorial_inputs')).rows.length,1);
 await run('handleEditorialMessage(msgArg)',{msgArg:{sender:{user_id:7},body:{mid:'rule-good',text:'Исключить: реклама'}}});
 assert.deepEqual((await tr()).rules.exclude,['реклама']);assert.equal((await sql('SELECT * FROM ep_editorial_inputs')).rows.length,0);
});
await test('Filtered collection retains original content and advances cursor without enqueue',async()=>{
 const r=await tr();await sql('UPDATE ep_cross_routes SET next_at=NOW(),enabled=TRUE WHERE id=$1',[r.id]);
 await sql("UPDATE ep_cross_items SET next_at=NOW()+INTERVAL '1 hour' WHERE route_id=$1",[r.id]);
 context.TEST.fetch={posts:[[92,'реклама — материал','u',{}]],cursor:92};await run('crossTick()');delete context.TEST.fetch;
 const i=(await sql('SELECT * FROM ep_cross_items WHERE route_id=$1 AND remote=92',[r.id])).rows[0];
 assert.equal(i.state,'skipped');assert.equal(i.original,'реклама — материал');assert.equal(i.post_id,null);assert.equal((await tr()).cursor,92);assert.ok((await tr()).checked_at);
});
await test('Published text edit keeps media and requires an explicit save',async()=>{
 const p=(await sql("SELECT * FROM ep_publications WHERE status='published' ORDER BY id LIMIT 1")).rows[0];assert.ok(p);
 context.TEST.edits=[];
 await run('queueMaxWrite=async(path,method,body)=>{TEST.edits.push({path,method,body});return {success:true};};');
 await run('handleEditorialCallback(cbArg)',{cbArg:{callback:{user:{user_id:7},payload:`we_${p.id}`}}});
 await run('handleEditorialMessage(msgArg)',{msgArg:{sender:{user_id:7},body:{mid:'published-edit-test',text:'Исправленный текст опубликованного поста'}}});
 assert.equal(context.TEST.edits.length,0);
 await run('handleEditorialCallback(cbArg)',{cbArg:{callback:{user:{user_id:7},payload:`wc_${p.id}`}}});
 assert.equal(context.TEST.edits.length,1);assert.equal(JSON.stringify(context.TEST.edits[0].body),JSON.stringify({text:'Исправленный текст опубликованного поста'}));
 const after=(await sql('SELECT * FROM ep_publications WHERE id=$1',[p.id])).rows[0];assert.deepEqual(after.body_snapshot.attachments,p.body_snapshot.attachments);assert.equal(after.edit_revision,1);
 await run('handleEditorialCallback(cbArg)');assert.equal(context.TEST.edits.length,1);
});
await test('Read-only bridge retries transient responses and legacy uploads never auto-retry',async()=>{
 const start=source.indexOf('async function crossBridge(payload){'),end=source.indexOf('async function crossAccess',start);
 const isolated=vm.createContext({crypto,Buffer,TOKEN:'fake',BRIDGE_URL:'https://bridge.example/max-crosspost',Date,JSON,Error,sleep:async()=>{},httpsRequest:async()=>{isolated.calls++;return isolated.calls===1?{status:503,text:'warming'}:{status:200,text:'{"ok":true}'};},calls:0});
 vm.runInContext(source.slice(start,end),isolated);assert.equal((await vm.runInContext('crossBridge({action:"trustat_fetch"})',isolated)).ok,true);assert.equal(isolated.calls,2);
 for(const action of ['content_fetch']){
  isolated.calls=0;assert.equal((await vm.runInContext(`crossBridge({action:"${action}"})`,isolated)).ok,true);assert.equal(isolated.calls,2);
 }
 for(const action of ['prepare']){
  isolated.calls=0;await assert.rejects(()=>vm.runInContext(`crossBridge({action:"${action}"})`,isolated));assert.equal(isolated.calls,1);
 }
 isolated.calls=0;isolated.httpsRequest=async()=>{isolated.calls++;return {status:503,text:'{"ok":false,"message":"warming"}'};};
 await assert.rejects(()=>vm.runInContext('crossBridge({action:"content_fetch"})',isolated),/warming/);assert.equal(isolated.calls,3);
 isolated.calls=0;isolated.httpsRequest=async()=>{isolated.calls++;return {status:422,text:'{"ok":false,"message":"Unavailable source"}'};};
 await assert.rejects(()=>vm.runInContext('crossBridge({action:"content_fetch"})',isolated),/Unavailable source/);assert.equal(isolated.calls,1);
 isolated.calls=0;isolated.httpsRequest=async()=>{isolated.calls++;if(isolated.calls===1)throw Error('timeout');return {status:200,text:'{"ok":true}'};};
 assert.equal((await vm.runInContext('crossBridge({action:"content_fetch"})',isolated)).ok,true);assert.equal(isolated.calls,2);
});

await test('TikTok readiness retries without upload; cached preparation retries lost responses safely',async()=>{
 const start=source.indexOf('async function crossBridge(payload){'),end=source.indexOf('async function crossAccess',start);
 const isolated=vm.createContext({crypto,Buffer,TOKEN:'fake',BRIDGE_URL:'https://bridge.example/max-crosspost',Date,JSON,Error,sleep:async()=>{},health:0,prepares:0,
 httpsRequest:async(url,options)=>{const p=JSON.parse(options.body);
  if(p.action==='content_health'){isolated.health++;return isolated.health===1?{status:200,text:'warming'}:{status:200,text:JSON.stringify({ok:true,service:'everypost-content',version:2})};}
  isolated.prepares++;if(isolated.prepares===1)throw Error('response lost');return {status:200,text:JSON.stringify({ok:true,body:{cached:true}})};
 }});
 vm.runInContext(source.slice(start,end),isolated);
 assert.equal((await vm.runInContext('crossBridge({action:"content_prepare"})',isolated)).body.cached,true);
 assert.equal(isolated.health,2);assert.equal(isolated.prepares,2);
 isolated.prepares=0;isolated.httpsRequest=async()=>({status:200,text:'not json'});
 await assert.rejects(()=>vm.runInContext('crossBridge({action:"content_prepare"})',isolated),e=>e.safeRetry&&/HTTP 200/.test(e.message));
 assert.equal(isolated.prepares,0);
});


await test('Related publication link is validated and never queues a held material',async()=>{
 const r=await tr(),pub=(await sql("SELECT * FROM ep_publications WHERE status='published' ORDER BY id LIMIT 1")).rows[0];
 await sql('UPDATE ep_cross_routes SET channel_id=$2 WHERE id=$1',[r.id,pub.channel_id]);
 const item=(await sql("INSERT INTO ep_cross_items(route_id,remote,original,url,media,mode,state,related_publication) VALUES($1,990,'Продолжение истории','u','{}','original','failed',$2) RETURNING *",[r.id,pub.id])).rows[0];
 const channel=(await sql('SELECT * FROM channels WHERE id=$1',[pub.channel_id])).rows[0];
 context.TEST.previousMaxRequest=await run('maxRequest');
 context.TEST.relatedMessage={body:{mid:pub.message_id},recipient:{chat_id:channel.max_chat_id},url:'https://max.ru/test/verified-message'};
 await run('maxRequest=async()=>({messages:[TEST.relatedMessage]});');
 const cb={callback:{user:{user_id:7},payload:`wl_${item.id}`}};
 await run('handleEditorialCallback(cbArg)',{cbArg:cb});await run('handleEditorialCallback(cbArg)',{cbArg:cb});
 const fresh=(await sql('SELECT * FROM ep_cross_items WHERE id=$1',[item.id])).rows[0];assert.equal(fresh.state,'failed');assert.equal(fresh.post_id,null);
 assert.equal(fresh.edited_text.split('Ранее сообщали').length,2);assert.equal(fresh.original,'Продолжение истории');
 assert.equal(await run('verifiedMaxPostLink("https://max.ru.evil.test/post")'),null);
 assert.equal(await run('verifiedMaxPostLink("https://attacker@max.ru/post")'),null);
 await run('maxRequest=TEST.previousMaxRequest;');
});
await test('Editing held text preserves review state until retry is chosen',async()=>{
 const i=(await sql("SELECT * FROM ep_cross_items WHERE remote=990")).rows[0];
 await run('handleEditorialCallback(cbArg)',{cbArg:{callback:{user:{user_id:7},payload:`wi_${i.id}`}}});
 await run('handleEditorialMessage(msgArg)',{msgArg:{sender:{user_id:7},body:{mid:'held-edit',text:'Исправленный материал'}}});
 const after=(await sql('SELECT * FROM ep_cross_items WHERE id=$1',[i.id])).rows[0];assert.equal(after.state,'failed');assert.equal(after.edited_text,'Исправленный материал');assert.equal(after.post_id,null);
});

async function wakePost(ageMinutes, status='scheduled') {
 const p=await draft([1]);
 await sql("UPDATE ep_posts SET status='scheduled' WHERE id=$1",[p.id]);
 const q=(await sql(`INSERT INTO ep_schedules(post_id,status,due_at,timezone,scheduled_by,access_version,body_snapshot)
 VALUES($1,$2,NOW()-($3*INTERVAL '1 minute'),'Europe/Moscow',7,0,$4) RETURNING *`,[p.id,status,ageMinutes,JSON.stringify(p.body)])).rows[0];
 return q;
}
await test('Wake-up drains overdue posts in schedule order once, leaving future and paused posts intact',async()=>{
 await sql("UPDATE ep_schedules SET status='cancelled'");
 const newer=await wakePost(10),older=await wakePost(180),future=await wakePost(-60),paused=await wakePost(200,'paused');
 const offset=sent.length;
 await run('processOneScheduled()');await run('processOneScheduled()');await run('processOneScheduled()');
 const rows=(await sql('SELECT * FROM ep_schedules WHERE id=ANY($1) ORDER BY published_at',[ [older.id,newer.id] ])).rows;
 assert.deepEqual(rows.map(x=>x.id),[older.id,newer.id]);assert.ok(rows.every(x=>x.status==='published'&&x.attempts===1));
 assert.equal(sent.length-offset,2);
 assert.equal((await sql('SELECT status FROM ep_schedules WHERE id=$1',[future.id])).rows[0].status,'scheduled');
 assert.equal((await sql('SELECT status FROM ep_schedules WHERE id=$1',[paused.id])).rows[0].status,'paused');
 assert.ok(out.some(x=>x.text?.includes('Опоздание: 180 мин.')));
});
await test('Overdue posts still check permissions and deletion deadlines',async()=>{
 await sql("UPDATE ep_schedules SET status='cancelled'");const deniedPost=await wakePost(180),offset=sent.length;
 denied.add('101');await run('processOneScheduled()');denied.clear();
 assert.equal((await sql('SELECT status FROM ep_schedules WHERE id=$1',[deniedPost.id])).rows[0].status,'paused');
 const expired=await wakePost(180);
 await sql(`INSERT INTO ep_auto_deletions(target_key,channel_id,capability,due_at,timezone,requested_by,access_version,enabled,status)
 VALUES($1,1,'create',NOW()-INTERVAL '1 minute','Europe/Moscow',7,0,TRUE,'armed')`,['p_'+expired.post_id]);
 await run('processOneScheduled()');assert.equal(sent.length,offset);
 assert.equal((await sql('SELECT status FROM ep_schedules WHERE id=$1',[expired.id])).rows[0].status,'paused');
});
await test('Wake-up never retries a request interrupted after dispatch started',async()=>{
 await sql("UPDATE ep_schedules SET status='cancelled'");const q=await wakePost(180,'sending'),offset=sent.length;
 await sql("UPDATE ep_schedules SET dispatch_started_at=NOW()-INTERVAL '3 hours' WHERE id=$1",[q.id]);
 await sql("UPDATE ep_posts SET status='publishing' WHERE id=$1",[q.post_id]);
 await run('processOneScheduled()');await run('processOneScheduled()');assert.equal(sent.length,offset);
 assert.equal((await sql('SELECT status FROM ep_schedules WHERE id=$1',[q.id])).rows[0].status,'needs_check');
});

console.log(`${count} integration scenarios passed`);
await db.close();
