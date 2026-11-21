/* Ordered device commands. A network retry reuses its original request ID. */
(function(root,factory){
  if(typeof module==='object' && module.exports) module.exports=factory();
  else root.QuietSpaceMonitoringEvents=factory();
})(typeof window==='object'?window:globalThis,function(){
  return class MonitoringEvents {
    constructor(send, { makeId=()=>{
      // Chromium 88 has secure random bytes but does not provide randomUUID.
      if(typeof globalThis.crypto.randomUUID==='function')return globalThis.crypto.randomUUID();
      const bytes=globalThis.crypto.getRandomValues(new Uint8Array(16));
      bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
      const hex=Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');
      return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    }, pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)) }={}) {
      this.send=send; this.makeId=makeId; this.pause=pause; this.tail=Promise.resolve();this.generation=0;
    }
    invalidate(){this.generation++;}
    enqueue(path,body) {
      const generation=this.generation;
      const packet={...body,request_id:this.makeId()};
      const action=this.tail.then(async()=>{
        for(let attempt=0;attempt<2;attempt++){
          if(generation!==this.generation)throw Object.assign(Error('Monitoring command cancelled'),{status:409});
          try{return await this.send(path,packet);}
          catch(error){if(attempt===1 || (error.status>=400 && error.status<500))throw error;await this.pause(250);}
        }
      });
      this.tail=action.catch(()=>{}); return action;
    }
  };
});
