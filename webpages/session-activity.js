/* Foreground activity refreshes the existing idle timestamp; background polling does not. */
(() => {
 let sent=0,pending;
 async function send(){sent=Date.now();try{const r=await fetch('/api/auth/activity',{method:'POST',headers:{'X-QuietSpace-Request':'1'}});if(r.status===401)location.replace('/webpages/login.html?restricted=1');}catch{}}
 function activity(){if(document.hidden)return;const remaining=15000-(Date.now()-sent);if(remaining<=0){clearTimeout(pending);pending=null;send();}else if(!pending)pending=setTimeout(()=>{pending=null;send();},remaining);}
 document.addEventListener('pointerdown',activity,{passive:true});document.addEventListener('keydown',activity);document.addEventListener('input',activity,{passive:true});document.addEventListener('wheel',activity,{passive:true});document.addEventListener('touchmove',activity,{passive:true});
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)activity();});
 window.addEventListener('pagehide',()=>clearTimeout(pending));
})();
