import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import https from 'node:https';
import tls from 'node:tls';
import assert from 'node:assert/strict';
import {test} from 'node:test';

function instance(env={}) {
  const routes=new Map(), middleware=[], intervals=[];
  const app={get:(p,fn)=>routes.set('GET '+p,fn),post:(p,fn)=>routes.set('POST '+p,fn),
    use:fn=>middleware.push(fn),disable(){},listen(port,host,callback){callback();}};
  const pool={on(){},query:async()=>({rows:[{}]})};
  const express=Object.assign(()=>app,{json:()=>()=>{}});
  const context=vm.createContext({console:{log(){},error(){}},crypto,https,tls,Buffer,URL,URLSearchParams,Date,
    setTimeout,clearTimeout,setInterval:(...args)=>{intervals.push(args);return {unref(){}};},
    process:{env:{MAX_BOT_TOKEN:'test',DATABASE_URL:'unused',...env}},express,
    pg:{Pool:class{constructor(){return pool;}}}});
  let source=fs.readFileSync(new URL('./index.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
  source=source.slice(0,source.lastIndexOf('start().catch'));
  vm.runInContext(source,context);
  const run=code=>vm.runInContext(code,context);
  async function health(){
    let status,body;
    await routes.get('GET /health')({}, {status(s){status=s;return this;},json(b){body=b;}});
    return {status,body};
  }
  return {run,health,pool,intervals,middleware};
}

test('Target origins configure webhook and bridge, reject unsafe origins',()=>{
  const app=instance({PUBLIC_URL:'https://max.example.org/',BRIDGE_URL:'https://tg.example.org'});
  assert.equal(app.run('WEBHOOK_URL'),'https://max.example.org/webhook');
  assert.equal(app.run('BRIDGE_URL'),'https://tg.example.org/max-crosspost');
  for(const PUBLIC_URL of ['http://max.example.org','https://a:b@example.org','https://example.org/path','https://example.org?q=x'])
    assert.throws(()=>instance({PUBLIC_URL}));
  assert.throws(()=>instance({EP_RUN_MODE:'stnadby'}));
});
test('Standby startup never registers bot commands/webhook or schedules workers',async()=>{
  const app=instance({EP_RUN_MODE:'standby'});
  await app.run('initDatabase=async()=>{};registerWebhook=()=>{throw Error("external effect")};registerCommands=registerWebhook;start()');
  assert.equal(app.intervals.length,0);
  assert.equal((await app.health()).status,200);
  let status,next=false;
  app.middleware[1]({method:'POST'},{status(s){status=s;return this;},json(){}},()=>{next=true;});
  assert.equal(status,503);assert.equal(next,false);
  app.middleware[1]({method:'GET'},{},()=>{next=true;});assert.equal(next,true);
});
test('Readiness refuses a dead database even when the HTTP process is up',async()=>{
  const app=instance({EP_RUN_MODE:'standby'});app.run('ready=true');
  assert.equal((await app.health()).status,200);
  app.pool.query=async()=>{throw Error('postgresql://secret@host')};
  const r=await app.health();assert.equal(r.status,503);assert.equal(JSON.stringify(r).includes('secret'),false);
});
test('Active readiness requires webhook setup and forward progress of every worker',async()=>{
  const app=instance();app.run('ready=true');assert.equal((await app.health()).status,503);
  app.run('webhookReady=true');assert.equal((await app.health()).status,200);
  for(const name of ['posting','crosspost','content']) {
    app.run('workerSeen.'+name+'=Date.now()-31*60000');assert.equal((await app.health()).status,503);
    app.run('workerSeen.'+name+'=Date.now()');assert.equal((await app.health()).status,200);
  }
});
