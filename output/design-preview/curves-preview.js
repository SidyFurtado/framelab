const presetPoints={linear:{x1:1/3,y1:1/3,x2:2/3,y2:2/3},'ease-out':{x1:.16,y1:.84,x2:.44,y2:1},'ease-in':{x1:.56,y1:0,x2:.84,y2:.16},'ease-in-out':{x1:.65,y1:0,x2:.35,y2:1}};
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
function safeCustom(p){const d={x1:.65,y1:0,x2:.35,y2:1};return Object.fromEntries(Object.keys(d).map(k=>[k,clamp(Number.isFinite(Number(p?.[k]))?Number(p[k]):d[k],k[0]==='x'?0:-.6,k[0]==='x'?1:1.6)]))}
function bezier(p,t){if(t<=0)return 0;if(t>=1)return 1;const at=(a,b,u)=>3*(1-u)*(1-u)*u*a+3*(1-u)*u*u*b+u*u*u;let lo=0,hi=1;for(let i=0;i<24;i++){const m=(lo+hi)/2;if(at(p.x1,p.x2,m)<t)lo=m;else hi=m}return at(p.y1,p.y2,(lo+hi)/2)}
function curveAt(id,t){
  if(id==='custom')return bezier(state.custom,t);
  if(presetPoints[id])return bezier(presetPoints[id],t);
  if(t<=0)return 0;if(t>=1)return 1;
  if(id==='punch')return (1-Math.pow(2,-3*t))/(1-Math.pow(2,-3));
  if(id==='expo-out')return 1-Math.pow(2,-10*t);
  if(id==='expo-in-out')return t<.5?Math.pow(2,20*t-10)/2:(2-Math.pow(2,-20*t+10))/2;
  if(id==='back-out'){const u=t-1;return 1+2.70158*u*u*u+1.70158*u*u}
  return t;
}
function ease(t){return curveAt(state.curve,t)}
function range(){return state.curve==='custom'?{lo:-.6,hi:1.6}:state.curve==='back-out'?{lo:-.14,hi:1.14}:{lo:0,hi:1}}
function project(x,y,w,h){const r=range();return {x:10+x*(w-20),y:10+(r.hi-y)/(r.hi-r.lo)*(h-20)}}
function projectControl(x,y,w,h){return project(x,state.tool!=='flow'&&state.direction==='out'?1-y:y,w,h)}
function point(t,w,h){return projectControl(t,ease(t),w,h)}
function renderGallery(){qa('.fl-curve-gallery [data-curve]').forEach(b=>{let d='';for(let i=0;i<=60;i++){const t=i/60,y=curveAt(b.dataset.curve,t);d+=`${i?'L':'M'}${(6+t*84).toFixed(2)},${(40-(y+.14)/1.28*34).toFixed(2)} `}b.querySelector('.fl-mini-curve').setAttribute('d',d)})}
function graph(){
  const box=q('#fl-graph'),svg=box.querySelector('svg');const w=Math.max(50,box.clientWidth),h=box.clientHeight;if(!h)return;
  const editing=state.curve==='custom';svg.setAttribute('viewBox',`0 0 ${w} ${h}`);let d='';
  for(let i=0;i<=120;i++){const p=point(i/120,w,h);d+=`${i?'L':'M'}${p.x.toFixed(2)},${p.y.toFixed(2)} `}
  q('.fl-motion-path').setAttribute('d',d);q('.fl-area-path').setAttribute('d',`${d} L${w-10},${h-10} L10,${h-10} Z`);
  const bottom=project(0,0,w,h).y,top=project(0,1,w,h).y;
  q('.fl-grid-path').setAttribute('d',`M10,${top} H${w-10} M10,${(top+bottom)/2} H${w-10} M10,${bottom} H${w-10} M${w/3},10 V${h-10} M${w*2/3},10 V${h-10}`);
  q('#fl-graph-top').style.top=(top-7)+'px';q('#fl-graph-bottom').style.top=(bottom-7)+'px';
  for(const [sel,t] of [['.fl-start-dot',0],['.fl-end-dot',1]]){const p=point(t,w,h);q(sel).setAttribute('cx',p.x);q(sel).setAttribute('cy',p.y)}
  q('.fl-handle-lines').style.display=editing?'':'none';qa('[data-handle]').forEach(b=>b.hidden=!editing);
  if(editing){const p=state.custom,a=point(0,w,h),z=point(1,w,h),c1=projectControl(p.x1,p.y1,w,h),c2=projectControl(p.x2,p.y2,w,h);q('.fl-handle-lines').setAttribute('d',`M${a.x},${a.y} L${c1.x},${c1.y} M${z.x},${z.y} L${c2.x},${c2.y}`);[c1,c2].forEach((v,i)=>{const b=q(`[data-handle="${i+1}"]`);b.style.left=v.x+'px';b.style.top=v.y+'px';b.setAttribute('aria-label',`Ponto de ${i?'saída':'entrada'}. X ${p['x'+(i+1)].toFixed(2)}, Y ${p['y'+(i+1)].toFixed(2)}. Arraste ou use as setas.`)});qa('[data-coordinate]').forEach(e=>{if(document.activeElement!==e)e.value=state.custom[e.dataset.coordinate].toFixed(2)})}
}
function editorState(){const editing=state.curve==='custom';q('.fl-curve-panel').classList.toggle('fl-editing',editing);q('.fl-editor-meta').hidden=!editing;q('.fl-fine-tune').hidden=!editing;q('.fl-runner').style.display='none';q('.fl-playhead').style.opacity='0';q('#fl-preview span').textContent='Reproduzir';q('.fl-parameters').hidden=state.tool==='flow';q('#fl-zoom-screen .fl-note span').textContent=state.tool==='flow'?'Curva aplicada entre os keyframes selecionados.':'Novo efeito Transform · Motion original preservado';q('#fl-graph-bottom').textContent=state.tool==='flow'?'0%':'100%';q('#fl-graph-start').textContent=state.tool==='flow'?'0%':'0,0 s';if(state.tool==='flow'){q('#fl-graph-top').textContent='100%';q('#fl-graph-end').textContent='100%';q('#fl-action-summary').textContent=curveNames[state.curve]+' · Keyframes selecionados'}}
function selectCurve(id){cancelAnimationFrame(frame);if(id==='custom'&&!state.customEdited)state.custom={...(presetPoints[state.curve]||{x1:.16,y1:.84,x2:.44,y2:1})};state.curve=id;draw();if(id!=='custom')play();persist()}
qa('[data-handle]').forEach(button=>{
  let dragging=false;
  function move(e){if(!dragging)return;const box=q('#fl-graph'),rect=box.getBoundingClientRect(),r=range(),i=button.dataset.handle;const x=clamp((e.clientX-rect.left-10)/(rect.width-20),0,1);let y=clamp(r.hi-(e.clientY-rect.top-10)/(rect.height-20)*(r.hi-r.lo),-.6,1.6);if(state.tool!=='flow'&&state.direction==='out')y=1-y;state.custom={...state.custom,['x'+i]:x,['y'+i]:y};state.customEdited=true;graph()}
  button.addEventListener('pointerdown',e=>{if(e.button!==0)return;cancelAnimationFrame(frame);q('.fl-runner').style.display='none';dragging=true;button.setPointerCapture(e.pointerId);e.preventDefault();button.focus()});
  button.addEventListener('pointermove',move);
  function finish(){if(!dragging)return;dragging=false;persist()}
  button.addEventListener('pointerup',finish);button.addEventListener('pointercancel',finish);button.addEventListener('lostpointercapture',finish);
  button.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();const i=button.dataset.handle,amount=e.shiftKey?.1:.01,p={...state.custom};if(e.key==='ArrowLeft')p['x'+i]-=amount;if(e.key==='ArrowRight')p['x'+i]+=amount;const sign=state.tool!=='flow'&&state.direction==='out'?-1:1;if(e.key==='ArrowUp')p['y'+i]+=amount*sign;if(e.key==='ArrowDown')p['y'+i]-=amount*sign;state.custom=safeCustom(p);state.customEdited=true;graph();persist()});
});
qa('[data-coordinate]').forEach(input=>input.addEventListener('input',()=>{if(input.value===''||!Number.isFinite(input.valueAsNumber))return;state.custom=safeCustom({...state.custom,[input.dataset.coordinate]:input.valueAsNumber});state.customEdited=true;cancelAnimationFrame(frame);graph()}));
qa('[data-coordinate]').forEach(input=>input.addEventListener('change',()=>{input.value=state.custom[input.dataset.coordinate].toFixed(2);persist()}));
q('#fl-reset-curve').addEventListener('click',()=>{state.custom={x1:.16,y1:.84,x2:.44,y2:1};state.customEdited=true;draw();persist()});
