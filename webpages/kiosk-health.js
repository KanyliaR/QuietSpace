/* Bounded numeric/enum diagnostics only: never retain audio, credentials or request bodies. */
(function(root,factory){if(typeof module==='object')module.exports=factory();else root.QuietSpaceKioskHealth=factory();})(typeof window==='object'?window:globalThis,()=>class KioskHealth{
 constructor(now=Date.now){this.now=now;this.times={sample:0,evaluation:0,reading:0,heartbeat:0,config:0};this.events=[];this.attempts=0;this.nextAttempt=0;this.started=0;this.lastRequest=null;this.lastError=null;this.describe=()=>({});}
 mark(kind){if(Object.prototype.hasOwnProperty.call(this.times,kind))this.times[kind]=this.now();}
 event(kind,code=0){this.events.push({at:this.now(),kind,code});if(this.events.length>32)this.events.shift();}
 request(info){if(info.ok&&info.path==='/api/device/heartbeat')this.mark('heartbeat');if(info.ok&&info.path==='/api/readings')this.mark('reading');this.lastRequest={at:this.now(),path:info.path,status:info.status,duration:info.duration,ok:!!info.ok,error:info.error||null};if(!info.ok)this.event(info.error||'http_failure',info.status);}
 begin(){this.started=this.now();this.event('capture_start');}
 failure(reason){this.event(reason);this.attempts=Math.min(this.attempts+1,10);this.nextAttempt=this.now()+Math.min(30000,2000*Math.pow(2,this.attempts-1));}
 ready(){return this.now()>=this.nextAttempt;}
 healthy(){this.attempts=0;this.nextAttempt=0;}
 stale(){const now=this.now();if(!this.started||now-this.started<5000)return null;if(now-Math.max(this.times.sample,this.started)>3000)return 'sample_stalled';if(now-Math.max(this.times.evaluation,this.started)>4000)return 'evaluation_stalled';if(now-Math.max(this.times.reading,this.started)>8000)return 'submission_stalled';return null;}
 fault(error,line=0,column=0){this.lastError={at:this.now(),kind:['TypeError','ReferenceError','RangeError','SyntaxError','Error'].includes(error?.name)?error.name:'Error',line:Number.isInteger(line)?line:0,column:Number.isInteger(column)?column:0};this.event('application_error',this.lastError.line);}
 snapshot(){return {version:1,at:this.now(),started:this.started,times:{...this.times},attempts:this.attempts,nextAttempt:this.nextAttempt,lastRequest:this.lastRequest,lastError:this.lastError,events:this.events.slice(),...this.describe()};}
});
