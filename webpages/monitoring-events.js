/* Ordered device commands. A network retry reuses its original request ID. */
(function(root,factory){
  if(typeof module==='object' && module.exports) module.exports=factory();
  else root.QuietSpaceMonitoringEvents=factory();
})(typeof window==='object'?window:globalThis,function(){
  return class MonitoringEvents {
    constructor(send, { makeId=()=>globalThis.crypto.randomUUID(), pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)) }={}) {
      this.send=send; this.makeId=makeId; this.pause=pause; this.tail=Promise.resolve();
    }
    enqueue(path,body) {
      const packet={...body,request_id:this.makeId()};
      const action=this.tail.then(async()=>{
        for(let attempt=0;attempt<2;attempt++){
          try{return await this.send(path,packet);}
          catch(error){if(attempt===1 || (error.status>=400 && error.status<500))throw error;await this.pause(250);}
        }
      });
      this.tail=action.catch(()=>{}); return action;
    }
  };
});
