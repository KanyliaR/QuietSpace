/* Pure, deterministic calibration math. No browser storage, network or production imports. */
(function(root,factory){const api=factory();if(typeof module==='object')module.exports=api;else root.CalibrationAnalysis=api;})(globalThis,()=>{
 const labels=['quiet','moderate','loud'];
 const round=x=>Math.floor(x+.5);
 function rms(bytes){if(!bytes.length)throw Error('Empty audio buffer');return Math.sqrt(bytes.reduce((s,b)=>s+((b-128)/128)**2,0)/bytes.length);}
 class WindowProcessor{
  constructor(){this.reset();}reset(){this.points=[];this.started=null;this.last=null;this.evaluated=-Infinity;}
  push(bytes,time){if(this.last!==null&&(time<=this.last||time-this.last>500))this.reset();this.last=time;if(this.started===null)this.started=time;const amplitude=rms(bytes),instant=round(amplitude*500);this.points.push({time,level:instant});while(this.points.length&&time-this.points[0].time>3000)this.points.shift();if(time-this.evaluated<1000)return null;this.evaluated=time;return {time,rms:amplitude,instant,smoothed:round(this.points.reduce((s,p)=>s+p.level,0)/this.points.length),ready:time-this.started>=3000};}
 }
 function percentile(sorted,p){if(!sorted.length)return null;const x=(sorted.length-1)*p,i=Math.floor(x);return sorted[i]+(sorted[Math.min(i+1,sorted.length-1)]-sorted[i])*(x-i);}
 function stats(points){const values=points.filter(p=>p.ready&&Number.isFinite(p.smoothed)).map(p=>p.smoothed).sort((a,b)=>a-b);if(!values.length)return null;const mean=values.reduce((a,b)=>a+b,0)/values.length;return {mean,min:values[0],max:values.at(-1),median:percentile(values,.5),p05:percentile(values,.05),p95:percentile(values,.95),sd:Math.sqrt(values.reduce((s,x)=>s+(x-mean)**2,0)/values.length),count:values.length};}
 function validate(y,r){if(!Number.isInteger(y)||!Number.isInteger(r)||y<0||r>500||y>=r)throw Error('Use integer thresholds with 0 ≤ yellow < red ≤ 500.');return {yellow:y,red:r};}
 const classify=(value,y,r)=>value<y?'quiet':value<r?'moderate':'loud';
 function groups(sessions){return labels.map(label=>sessions.filter(s=>s.label===label&&!s.excluded&&s.status==='complete').flatMap(s=>s.points.filter(p=>p.ready).map(p=>p.smoothed)));}
 function evaluate(sessions,y,r){validate(y,r);const sets=groups(sessions);const categories=sets.map((values,i)=>{const confusion=[0,0,0];for(const value of values)confusion[labels.indexOf(classify(value,y,r))]++;return {label:labels[i],count:values.length,correct:confusion[i],incorrect:values.length-confusion[i],accuracy:values.length?confusion[i]/values.length:0,confusion};});return {balancedAccuracy:categories.reduce((s,c)=>s+c.accuracy,0)/3,categories};}
 function recommend(sessions){const sets=groups(sessions);if(sets.some(a=>a.length<10))throw Error('Record at least 10 full-window readings in each category. Aim for 30–60 seconds per test.');
  const bins=sets.map(values=>{const counts=Array(502).fill(0);for(const x of values)counts[Math.max(0,Math.min(500,Math.round(x)))+1]++;for(let i=1;i<counts.length;i++)counts[i]+=counts[i-1];return counts;});
  let best=-1,candidates=[];for(let y=0;y<500;y++)for(let r=y+1;r<=500;r++){const score=(bins[0][y]/sets[0].length+(bins[1][r]-bins[1][y])/sets[1].length+(sets[2].length-bins[2][r])/sets[2].length)/3;if(score>best+1e-12){best=score;candidates=[[y,r]];}else if(Math.abs(score-best)<=1e-12)candidates.push([y,r]);}
  const med=sets.map(a=>percentile([...a].sort((a,b)=>a-b),.5)),ideal=[(med[0]+med[1])/2,(med[1]+med[2])/2];candidates.sort((a,b)=>(Math.abs(a[0]-ideal[0])+Math.abs(a[1]-ideal[1]))-(Math.abs(b[0]-ideal[0])+Math.abs(b[1]-ideal[1]))||a[0]-b[0]||a[1]-b[1]);const [yellow,red]=candidates[0];
  const warnings=[];const sorted=sets.map(a=>[...a].sort((a,b)=>a-b));if(percentile(sorted[0],.95)>=percentile(sorted[1],.05))warnings.push('Quiet and moderate distributions overlap; repeat representative tests if this boundary is ambiguous.');if(percentile(sorted[1],.95)>=percentile(sorted[2],.05))warnings.push('Moderate and loud distributions overlap; repeat those tests if needed.');if(best<.8)warnings.push('Balanced training accuracy is below 80%; repeat the recordings before deployment.');if(!(med[0]<med[1]&&med[1]<med[2]))warnings.push('Category medians are not ordered from quiet to loud. Check labels and repeat tests.');
  return {yellow,red,...evaluate(sessions,yellow,red),warnings,explanation:'Exhaustive integer threshold search maximizes the mean of three category accuracies. Each category has equal weight. Ties favor boundaries nearest adjacent category-median midpoints, then lower yellow/red values. Accuracy describes these recordings, not unseen environments.'};
 }
 return {rms,WindowProcessor,stats,percentile,validate,classify,groups,evaluate,recommend,labels};
});
