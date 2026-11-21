/* Device secrets are exchanged once for a persistent server-validated HttpOnly cookie. */
(function(root,factory){if(typeof module==='object')module.exports=factory();else root.QuietSpaceRoomDeviceSession=factory();})(typeof window==='object'?window:globalThis,()=>class RoomDeviceSession{
 constructor({roomId,fetch:request,onRequest=()=>{}}){this.roomId=roomId;this.fetch=request;this.authenticated=false;this.onRequest=onRequest;}
 async request(url,options={}){
  const {timeoutMs=3000,readJson=false,...fetchOptions}=options;
  const headers=new Headers(fetchOptions.headers);headers.set('X-QuietSpace-Request','1');
  const controller=new AbortController();let timer,abortListener,status=0;
  const started=Date.now();
  const failure=(name)=>Object.assign(Error(name==='TimeoutError'?'Device request timed out. Check the server connection and try again.':'Device request cancelled.'),{name});
  const cancelled=new Promise((resolve,reject)=>{
   timer=setTimeout(()=>{controller.abort();reject(failure('TimeoutError'));},timeoutMs);
   abortListener=()=>{controller.abort();reject(failure('AbortError'));};
   if(options.signal?.aborted)abortListener();else options.signal?.addEventListener('abort',abortListener,{once:true});
  });
  try{
   const operation=(async()=>{
    const response=await this.fetch(url,{...fetchOptions,headers,signal:controller.signal,credentials:'same-origin'});
    if(controller.signal.aborted)throw failure('AbortError');
    status=response.status||0;if(status===401)this.authenticated=false;
    // The deadline includes the response body, not just the response headers.
    if(!readJson)return response;
    let data;try{data=await response.json();}catch(error){throw Object.assign(Error('Device returned an invalid response (HTTP '+status+').'),{name:'ResponseError',status});}
    return {response,data};
   })();
   const result=await Promise.race([operation,cancelled]);
   this.onRequest({path:String(url).split('?')[0],status,duration:Date.now()-started,ok:readJson?result.response.ok:result.ok});
   return result;
  }catch(error){this.onRequest({path:String(url).split('?')[0],status,duration:Date.now()-started,ok:false,error:error.name==='TimeoutError'?'timeout':error.name==='AbortError'?'cancelled':'request_failed'});throw error;}
  finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abortListener);}
 }
 json(url,options={}){return this.request(url,{...options,readJson:true});}
 async config(){let result;try{result=await this.json('/api/device/config?room_id='+this.roomId,{cache:'no-store',timeoutMs:1800});}catch(error){if(error.status===401)throw Error('Device enrollment required');throw error;}const {response,data:config}=result;if(!response.ok)throw Object.assign(Error(response.status===401?'Device enrollment required':response.status===403?'Device is assigned to another room':'Device control unavailable'),{status:response.status});if(Number(config?.room_id)!==this.roomId)throw Error('Device is assigned to another room');this.authenticated=true;return config;}
 async enroll(key){
  if(!/^[a-f0-9]{64}$/.test(key||''))throw Error('Enter the registered 64-character device key');
  let result;
  try{result=await this.json('/api/device/enroll',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({room_id:this.roomId}),timeoutMs:5000});}
  catch(error){if(error instanceof SyntaxError)throw Error('Device enrollment returned an invalid response.');throw error;}
  const {response,data}=result;
  if(!response.ok)throw Error(typeof data?.message==='string'?data.message:'Device enrollment failed (HTTP '+response.status+').');
  if(Number(data?.room_id)!==this.roomId)throw Error('Enrollment response did not confirm the assigned room.');
  this.authenticated=true;return data;
 }
 async heartbeat(state){if(!this.authenticated)throw Error('Device enrollment required');const {response}=await this.json('/api/device/heartbeat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({room_id:this.roomId,microphone_state:state}),timeoutMs:3000});if(!response.ok)throw Object.assign(Error('Device health update rejected'),{status:response.status});}
 async disconnect(){const {response}=await this.json('/api/device/disconnect',{method:'POST',timeoutMs:3000});if(!response.ok)throw Error('Device disconnect failed');this.authenticated=false;}
});
