const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const Session=require('../webpages/room-device-session'),Control=require('../webpages/device-control'),Health=require('../webpages/kiosk-health');
const flush=async()=>{for(let i=0;i<32;i++)await Promise.resolve();};
function display(){
 let clock=100000,next=0;const timers=new Map(),elements=new Map(),handlers={},tracks=[],contexts=[],calls=[];
 const state={enabled:true,online:true,authorized:true,blocked:false,holdPermission:false,holdReadings:false,color:'green',readingsPending:0,maxReadingsPending:0};
 const element=id=>{if(!elements.has(id))elements.set(id,{style:{},dataset:{},classList:{add(){},remove(){},toggle(){}},textContent:'',addEventListener(){},hidden:false});return elements.get(id);};
 const timer=(fn,delay,interval=0)=>{const id=++next;timers.set(id,{fn,at:clock+delay,interval});return id;};
 class FakeDate extends Date{constructor(...args){super(...(args.length?args:[clock]));}static now(){return clock;}}
 const context={console,URL,URLSearchParams,Headers,AbortController,AbortSignal,Uint8Array,Date:FakeDate,crypto:globalThis.crypto,
  QuietSpaceKioskHealth:class extends Health{constructor(){super(()=>clock);}},
  QuietSpaceRoomDeviceSession:class extends Session{},
  QuietSpaceDeviceControl:class extends Control{constructor(options){super({...options,now:()=>clock});}},
  QuietSpaceMonitoringEvents:require('../webpages/monitoring-events'),
  location:{href:'https://test.invalid/webpages/index.html?room_id=1',origin:'https://test.invalid',search:'?room_id=1'},
  sessionStorage:{removeItem(){}},document:{visibilityState:'visible',addEventListener(type,fn){handlers[type]=fn;},body:{style:{},dataset:{},classList:{add(){},remove(){},toggle(){}}},getElementById:element,querySelector:element},
  setTimeout:(fn,ms)=>timer(fn,ms),clearTimeout:id=>timers.delete(id),setInterval:(fn,ms)=>timer(fn,ms,ms),clearInterval:id=>timers.delete(id),
  addEventListener(type,fn){handlers[type]=fn;},
  navigator:{mediaDevices:{getUserMedia:()=>{
   if(state.blocked)return Promise.reject(Object.assign(Error('permission'),{name:'NotAllowedError'}));
   const track={readyState:'live',enabled:true,muted:false,onended:null,stop(){this.readyState='ended';}};tracks.push(track);
   const stream={getTracks:()=>[track],getAudioTracks:()=>[track]};
   return state.holdPermission?new Promise(resolve=>{state.releasePermission=()=>resolve(stream);}):Promise.resolve(stream);
  }}},
  AudioContext:class{constructor(){this.state='running';contexts.push(this);}resume(){return Promise.resolve();}createAnalyser(){return {getByteTimeDomainData(bytes){bytes.fill(128);}};}createMediaStreamSource(){return {connect(){},disconnect(){}};}close(){this.state='closed';return Promise.resolve();}},
  fetch:async(url,options={})=>{
   calls.push({path:String(url).split('?')[0],body:options.body?JSON.parse(options.body):null});
   if(!state.online)throw Error('offline');
   const body=options.body?JSON.parse(options.body):{};
   if(String(url).includes('/api/device/config'))return {status:state.authorized?200:401,ok:state.authorized,json:async()=>state.authorized?{room_id:1,room_name:'Room 232',monitoring_enabled:state.enabled,current_state:state.color,incident:state.color==='red'?{id:7,timer_started_at:new Date(80000).toISOString(),notification_recorded:true}:null,server_time:new Date(clock).toISOString(),yellowThreshold:10,redThreshold:17}:{}};
   if(String(url).endsWith('/api/readings')&&state.holdReadings){state.readingsPending++;state.maxReadingsPending=Math.max(state.maxReadingsPending,state.readingsPending);return new Promise((resolve,reject)=>{options.signal.addEventListener('abort',()=>{state.readingsPending--;reject(Error('aborted'));});state.releaseReading=()=>{state.readingsPending--;resolve({status:201,ok:true,json:async()=>({})});};});}
   if(String(url).endsWith('/api/incidents/state'))state.color=body.state;
   return {status:200,ok:true,json:async()=>({incident_id:1})};
  }
 };
 context.window=context;vm.createContext(context);
 const source=fs.readFileSync('webpages/index.html','utf8');const script=[...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].pop()[1];vm.runInContext(script,context);
 const evaluate=s=>vm.runInContext(s,context);
 async function advance(ms,skipSamples=false){const end=clock+ms;let iterations=0;while(true){const due=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;assert.ok(iterations++<10000);const [id,t]=due;timers.delete(id);clock=t.at;if(skipSamples&&t.fn.name==='updateSoundLevel')continue;if(t.interval)timers.set(id,{...t,at:clock+t.interval});t.fn();await flush();}clock=end;await flush();}
 return {context,state,calls,tracks,contexts,handlers,element,evaluate,advance,flush,health:()=>context.quietspaceKioskHealth.snapshot()};
}

test('configuration body deadlines free the polling lock and permit subsequent recovery',async()=>{
 let stall=true;const session=new Session({roomId:1,fetch:async()=>({ok:true,status:200,json:()=>stall?new Promise(()=>{}):Promise.resolve({room_id:1,monitoring_enabled:true})})});
 const control=new Control({roomId:1,getConfig:async()=>{const {data}=await session.json('/api/device/config',{timeoutMs:10});return data;},stop(){},onState(){},resume:async()=>{}});
 assert.equal(await control.check(),false);assert.equal(control.busy,false);assert.equal(control.allowed(),false);
 stall=false;assert.equal(await control.check(),true);assert.equal(control.busy,false);
});

test('track ending and AudioContext suspension retry capture without resetting enrollment',async()=>{
 const page=display();await page.flush();assert.equal(page.health().monitoring,true);await page.advance(1200);assert.equal(page.health().live,true);
 page.tracks[0].onended();assert.equal(page.health().live,false);assert.match(page.element('statusText').textContent,/UNAVAILABLE/);
 await page.advance(6000);assert.equal(page.health().monitoring,true);assert.equal(page.health().authenticated,true);
 const audio=page.contexts[page.contexts.length-1];audio.state='suspended';audio.onstatechange();assert.equal(page.health().live,false);
 await page.advance(10000);assert.equal(page.health().live,true);assert.equal(page.calls.filter(c=>c.path==='/api/device/enroll').length,0);
});

test('stalled sampling/evaluation is detected independently of animation frames',async()=>{
 const page=display();await page.flush();await page.advance(1200);
 await page.advance(4500,true);assert.ok(page.health().events.some(e=>e.kind==='sample_stalled'));
 assert.equal(page.health().live,false);await page.advance(10000);assert.equal(page.health().live,true);
 await page.advance(5000);page.evaluate('kioskHealth.times.evaluation=1');await page.advance(1000,true);assert.ok(page.health().events.some(e=>e.kind==='evaluation_stalled'));
});

test('network interruption recovers, but administrator disable and auth failure stop capture',async()=>{
 const page=display();await page.flush();await page.advance(1200);page.state.online=false;await page.advance(2000);
 assert.equal(page.health().live,false);assert.equal(page.health().authorized,false);
 page.state.enabled=false;page.state.online=true;await page.advance(6000);assert.equal(page.health().monitoring,false);assert.equal(page.health().administrativelyDisabled,true);assert.match(page.element('statusText').textContent,/MONITORING/);
 page.state.enabled=true;await page.advance(8000);assert.equal(page.health().live,true);
 page.state.authorized=false;await page.advance(2000);assert.equal(page.health().monitoring,false);assert.equal(page.health().authenticated,false);
});

test('repeated microphone failures use capped backoff; disable during pending permission releases late tracks',async()=>{
 const page=display();await page.flush();page.tracks[0].onended();page.state.blocked=true;
 const before=page.tracks.length;await page.advance(60000);assert.ok(page.health().attempts>=3);assert.ok(page.health().attempts<=7);assert.equal(page.tracks.length,before);assert.equal(page.health().live,false);
 page.state.blocked=false;page.state.holdPermission=true;await page.advance(30000);
 assert.equal(typeof page.state.releasePermission,'function');page.state.enabled=false;await page.advance(2000);page.state.releasePermission();await page.flush();
 assert.equal(page.health().monitoring,false);assert.equal(page.tracks[page.tracks.length-1].readyState,'ended');
});

test('only one reading request is pending and late acknowledgements cannot restore live status after disable',async()=>{
 const page=display();page.state.holdReadings=true;await page.flush();await page.advance(2500);
 assert.equal(page.state.maxReadingsPending,1);assert.equal(page.health().live,false);
 page.state.enabled=false;await page.advance(2000);page.state.releaseReading();await page.flush();assert.equal(page.health().live,false);assert.equal(page.health().monitoring,false);
});

test('health history is bounded and monitoring command cancellation does not generate duplicate retries',async()=>{
 const health=new Health();health.request({path:'/api/device/heartbeat',status:200,duration:1,ok:true});assert.ok(health.times.heartbeat>0);for(let i=0;i<100;i++)health.event('test',i);assert.equal(health.snapshot().events.length,32);
 const Queue=require('../webpages/monitoring-events');let count=0,release;
 const queue=new Queue(async()=>{count++;if(count===1)await new Promise(resolve=>{release=resolve;});return {};});
 const first=queue.enqueue('/state',{});await flush();const second=queue.enqueue('/state',{});queue.invalidate();release();await first;await assert.rejects(second,/cancelled/);assert.equal(count,1);
});


test('recovering an existing red incident restores its timer without a duplicate incident start',async()=>{
 const page=display();page.state.color='red';await page.flush();await page.advance(1200);
 const original=page.evaluate('countdownStart');assert.equal(original,80000);
 page.tracks[0].onended();await page.advance(8000);
 assert.equal(page.evaluate('countdownStart'),original);
 assert.equal(page.calls.filter(c=>c.path==='/api/incidents/start').length,0);
 assert.equal(page.health().live,true);
});

test('muted input and visibility changes never fabricate activity or bypass disabled monitoring',async()=>{
 const page=display();await page.flush();await page.advance(1200);
 page.tracks[0].muted=true;page.tracks[0].onmute();assert.equal(page.health().live,false);
 page.state.enabled=false;page.context.document.visibilityState='hidden';page.handlers.visibilitychange();await page.advance(4000);
 page.context.document.visibilityState='visible';page.handlers.visibilitychange();await page.flush();
 assert.equal(page.health().monitoring,false);assert.equal(page.health().authorized,false);
 assert.equal(page.health().visibility,'visible');
});


test('missing monitoring flag is unavailable rather than an intentional administrative pause',async()=>{
 const control=new Control({roomId:1,getConfig:async()=>({room_id:1}),stop(){},onState(){},resume:async()=>assert.fail('must not capture')});
 assert.equal(await control.check(),false);assert.equal(control.disabledConfig,null);
});

test('a running AudioContext whose audio clock stops is detected',async()=>{
 const page=display();await page.flush();await page.advance(1200);
 page.contexts[page.contexts.length-1].currentTime=3;
 await page.advance(4500);
 assert.ok(page.health().events.some(event=>event.kind==='audio_clock_stalled'));
 assert.equal(page.health().live,false);
});
