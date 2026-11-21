/* Device secrets are exchanged once for a persistent server-validated HttpOnly cookie. */
(function(root,factory){if(typeof module==='object')module.exports=factory();else root.QuietSpaceRoomDeviceSession=factory();})(typeof window==='object'?window:globalThis,()=>class RoomDeviceSession{
 constructor({roomId,fetch:request}){this.roomId=roomId;this.fetch=request;this.authenticated=false;}
 async request(url,options={}){
  const {timeoutMs,...fetchOptions}=options;
  const headers=new Headers(fetchOptions.headers);headers.set('X-QuietSpace-Request','1');
  const controller=timeoutMs?new AbortController():null,abort=()=>controller.abort();let timer;
  if(controller){if(options.signal?.aborted)abort();else options.signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(abort,timeoutMs);}
  try{
   const response=await this.fetch(url,{...fetchOptions,headers,credentials:'same-origin',...(controller?{signal:controller.signal}:{})});
   if(response.status===401)this.authenticated=false;return response;
  }catch(error){if(controller?.signal.aborted&&!options.signal?.aborted)throw Error('Device request timed out. Check the server connection and try again.');throw error;}
  finally{clearTimeout(timer);if(controller)options.signal?.removeEventListener('abort',abort);}
 }
 async config(){const response=await this.request('/api/device/config?room_id='+this.roomId,{cache:'no-store',timeoutMs:1800});if(!response.ok)throw Error(response.status===401?'Device enrollment required':response.status===403?'Device is assigned to another room':'Device control unavailable');const config=await response.json();if(Number(config.room_id)!==this.roomId)throw Error('Device is assigned to another room');this.authenticated=true;return config;}
 async enroll(key){if(!/^[a-f0-9]{64}$/.test(key||''))throw Error('Enter the registered 64-character device key');const response=await this.request('/api/device/enroll',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({room_id:this.roomId}),timeoutMs:5000});let result;try{result=await response.json();}catch{throw Error('Device enrollment returned an invalid response (HTTP '+response.status+').');}if(!response.ok)throw Error(typeof result?.message==='string'?result.message:'Device enrollment failed (HTTP '+response.status+').');if(Number(result?.room_id)!==this.roomId)throw Error('Enrollment response did not confirm the assigned room.');this.authenticated=true;return result;}
 async heartbeat(state){if(!this.authenticated)return;const response=await this.request('/api/device/heartbeat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({room_id:this.roomId,microphone_state:state}),timeoutMs:3000});if(!response.ok)throw Error('Device health update rejected');}
 async disconnect(){const response=await this.request('/api/device/disconnect',{method:'POST',timeoutMs:3000});if(!response.ok)throw Error('Device disconnect failed');this.authenticated=false;}
});
