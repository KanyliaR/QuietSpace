const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs');
const Session=require('../webpages/room-device-session');
const key='a'.repeat(64);
const reply=(status,body)=>({ok:status>=200&&status<300,status,json:async()=>body});

test('device requests work without AbortSignal.timeout and preserve authenticated cookies/headers',async()=>{
 const calls=[];const client=new Session({roomId:1,fetch:async(url,options)=>{calls.push({url,options});return reply(200,{room_id:1});}});
 await client.enroll(key);await client.config();await client.heartbeat('active');await client.disconnect();
 assert.equal(calls.length,4);
 for(const {options} of calls){assert.ok(options.signal instanceof AbortSignal);assert.equal(options.credentials,'same-origin');assert.equal(options.headers.get('X-QuietSpace-Request'),'1');assert.equal(options.timeoutMs,undefined);}
 assert.equal(calls[0].options.headers.get('Authorization'),'Bearer '+key);
 assert.equal(calls[1].options.headers.get('Authorization'),null);
});

test('timeouts abort pending fetches; rejection and malformed success never confirm enrollment',async()=>{
 const client=new Session({roomId:1,fetch:async(url,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('aborted'))))});
 await assert.rejects(client.request('/test',{timeoutMs:5}),/timed out/);
 for(const [status,body,message] of [[403,{message:'Device is bound to another room'},/bound/],[200,{},/did not confirm/],[200,{room_id:2},/did not confirm/],[502,null,/HTTP 502/]]){
  client.fetch=async()=>reply(status,body);await assert.rejects(client.enroll(key),message);assert.equal(client.authenticated,false);
 }
 client.fetch=async()=>({ok:false,status:502,json:async()=>{throw Error('HTML proxy error');}});
 await assert.rejects(client.enroll(key),/invalid response/);
});

test('actual enrollment form stays open on failure and shows success only after server confirmation',async()=>{
 const source=fs.readFileSync('webpages/index.html','utf8');
 const handler=source.slice(source.indexOf("    const enrollmentDialog="),source.indexOf('    async function startMonitoring()'));
 const nodes=new Map();const element=id=>{if(!nodes.has(id))nodes.set(id,{value:'',open:false,handlers:{},addEventListener(type,fn){this.handlers[type]=fn;},showModal(){this.open=true;},close(){this.open=false;this.handlers.close?.();},focus(){}});return nodes.get(id);};
 let result=reply(403,{message:'Invalid or revoked device key'}),resolveEnrollment;
 const session=new Session({roomId:1,fetch:async()=>new Promise(resolve=>{resolveEnrollment=()=>resolve(result);})});
 let started=0;const context={document:{getElementById:element},deviceSession:session,resumeMicrophone:true,enrollmentFailure:'',startupError:'',messageText:{},startMonitoring:async()=>{started++;}};
 vm.createContext(context);vm.runInContext(handler,context);vm.runInContext('openDeviceEnrollment()',context);
 const dialog=element('deviceEnrollmentDialog'),input=element('deviceEnrollmentKey'),form=element('deviceEnrollmentForm'),status=element('deviceEnrollmentStatus'),submit=element('deviceEnrollmentSubmit');
 input.value=key;let pending=form.handlers.submit({preventDefault(){}});
 assert.equal(dialog.open,true);assert.equal(submit.disabled,true);assert.doesNotMatch(status.textContent,/confirmed by/);
 resolveEnrollment();await pending;assert.equal(dialog.open,true);assert.equal(status.textContent,'Invalid or revoked device key');assert.equal(session.authenticated,false);
 result=reply(200,{room_id:1});pending=form.handlers.submit({preventDefault(){}});resolveEnrollment();await pending;
 assert.equal(dialog.open,true);assert.match(status.textContent,/confirmed by the server/);assert.equal(input.value,'');assert.equal(started,0);assert.equal(context.resumeMicrophone,false);
 await form.handlers.submit({preventDefault(){}});assert.equal(dialog.open,false);assert.equal(started,1);
});

test('Chromium 88 command IDs use secure random bytes when randomUUID is unavailable',async()=>{
 const context={crypto:{getRandomValues:bytes=>require('node:crypto').webcrypto.getRandomValues(bytes)},Uint8Array,setTimeout};context.window=context;
 vm.createContext(context);vm.runInContext(fs.readFileSync('webpages/monitoring-events.js','utf8'),context);
 const packets=[];const queue=new context.QuietSpaceMonitoringEvents(async(path,body)=>packets.push(body));
 await queue.enqueue('/api/incidents/state',{state:'green'});await queue.enqueue('/api/incidents/state',{state:'yellow'});
 for(const packet of packets)assert.match(packet.request_id,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
 assert.notEqual(packets[0].request_id,packets[1].request_id);
});
