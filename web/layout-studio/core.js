(function(root) {
  'use strict';
  const number = (v, name) => { const n=Number(v); if(!Number.isFinite(n)) throw Error(name+' invalide.'); return n; };
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  // PromptForge: crypto.randomUUID exists only on HTTPS and localhost, and the
  // app is served over plain http on the tailnet. getRandomValues works anywhere.
  const uid=()=>{if(root.crypto&&typeof root.crypto.randomUUID==='function')return root.crypto.randomUUID();const b=root.crypto.getRandomValues(new Uint8Array(16));b[6]=b[6]&15|64;b[8]=b[8]&63|128;const h=[...b].map(x=>x.toString(16).padStart(2,'0')).join('');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`};
  function size(w,h) {
    w=number(w,'Largeur'); h=number(h,'Hauteur');
    if(w<128||h<128||w>8192||h>8192||w%16||h%16) throw Error('Dimensions : multiples de 16, entre 128 et 8192 pixels.');
    return {w,h};
  }
  function box(b,w,h) {
    const x=clamp(Math.round(number(b.x,'X')),0,w-1), y=clamp(Math.round(number(b.y,'Y')),0,h-1);
    return {x,y,w:clamp(Math.round(number(b.w,'Largeur')),1,w-x),h:clamp(Math.round(number(b.h,'Hauteur')),1,h-y)};
  }
  function resizeBox(o, edge, dx, dy, W, H) {
    let l=o.x,t=o.y,r=o.x+o.w,b=o.y+o.h;
    if(edge.includes('w'))l=clamp(o.x+dx,0,r-1);
    if(edge.includes('e'))r=clamp(o.x+o.w+dx,l+1,W);
    if(edge.includes('n'))t=clamp(o.y+dy,0,b-1);
    if(edge.includes('s'))b=clamp(o.y+o.h+dy,t+1,H);
    l=Math.round(l);r=Math.round(r);t=Math.round(t);b=Math.round(b);
    return {x:l,y:t,w:r-l,h:b-t};
  }
  function exportLayout(p) {
    size(p.w,p.h);
    return {summary:{meta:p.meta.split(',').map(t=>t.trim()).filter(Boolean),canvas:'single',caption:p.caption.trim()},items:p.items.map(i=>{
      const b=box(i,p.w,p.h);
      const r={label:i.label,caption:i.caption.trim(),bbox:[b.y-p.h/2,b.x-p.w/2,b.y+b.h-p.h/2,b.x+b.w-p.w/2]};
      if(i.label==='text') r.text=i.text;
      return r;
    }),bbox_coord_space:'abs_centralized',bbox_format:'yxyx'};
  }
  function parseLayout(o,w,h) {
    size(w,h);
    if(!o||o.bbox_coord_space!=='abs_centralized'||o.bbox_format!=='yxyx'||!Array.isArray(o.items)) throw Error('JSON MOSS attendu : abs_centralized et yxyx.');
    if(o.items.length>100) throw Error('Maximum : 100 éléments.');
    const items=o.items.map((i,n)=>{
      if(!i||!['object','text'].includes(i.label)||typeof i.caption!=='string'||!Array.isArray(i.bbox)||i.bbox.length!==4) throw Error('Élément '+(n+1)+' invalide.');
      const [y1,x1,y2,x2]=i.bbox.map(v=>number(v,'Coordonnée'));
      const x=x1+w/2,y=y1+h/2;
      if(x<0||y<0||x2+w/2>w||y2+h/2>h||x2<=x1||y2<=y1) throw Error('Élément '+(n+1)+' hors du canvas. Vérifie les dimensions d’import.');
      return {id:uid(),name:(i.label==='text'?'Texte ':'Élément ')+(n+1),label:i.label,caption:i.caption,text:typeof i.text==='string'?i.text:'',color:palette[n%palette.length],...box({x,y,w:x2-x1,h:y2-y1},w,h)};
    });
    return {version:1,w,h,caption:typeof o.summary?.caption==='string'?o.summary.caption:'',meta:Array.isArray(o.summary?.meta)?o.summary.meta.join(', '):'',items,strokes:[],background:null,paintVisible:true};
  }
  const palette=['#52e0c4','#bb9aff','#ffc16e','#80b7ff','#ff8aa7','#e3e5ec','#759378','#ad846d'];
  function project(raw) {
    if(!raw||raw.version!==1) throw Error('Projet MOSS Layout Studio invalide.');
    const {w,h}=size(raw.w,raw.h);
    if(!Array.isArray(raw.items)||raw.items.length>100||!Array.isArray(raw.strokes)||raw.strokes.length>10000) throw Error('Projet trop volumineux ou invalide.');
    let points=0;
    const strokes=raw.strokes.map(s=>{
      if(!Array.isArray(s.points)||!s.points.length) throw Error('Trait invalide.');
      points+=s.points.length;
      return {erase:!!s.erase,color:/^#[a-f0-9]{6}$/i.test(s.color)?s.color:palette[0],width:clamp(number(s.width,'Pinceau'),1,200),points:s.points.map(pt=>{
        if(!Array.isArray(pt)||pt.length!==2)throw Error('Point invalide.');
        return [clamp(number(pt[0],'X'),0,w),clamp(number(pt[1],'Y'),0,h)];
      })};
    });
    if(points>1000000)throw Error('Le dessin dépasse un million de points.');
    const background=typeof raw.background==='string'&&/^data:image\/(png|jpeg|webp|gif);base64,/i.test(raw.background)?raw.background:null;
    if(background&&background.length>9000000)throw Error('Image de repère trop volumineuse.');
    const ids=new Set();
    const items=raw.items.map((i,n)=>{
      let id=typeof i.id==='string'?i.id:uid();if(ids.has(id))id=uid();ids.add(id);
      return {id,name:String(i.name||'Élément '+(n+1)).slice(0,200),label:i.label==='text'?'text':'object',caption:String(i.caption||'').slice(0,20000),text:String(i.text||'').slice(0,20000),color:/^#[a-f0-9]{6}$/i.test(i.color)?i.color:palette[n%palette.length],...box(i,w,h)};
    });
    return {version:1,w,h,caption:String(raw.caption||'').slice(0,30000),meta:String(raw.meta||'').slice(0,1000),items,strokes,background,paintVisible:raw.paintVisible!==false};
  }
  const api={size,box,resizeBox,exportLayout,parseLayout,project,palette,clamp,uid};
  if(typeof module!=='undefined')module.exports=api;
  root.MossCore=api;
})(typeof window==='undefined'?globalThis:window);
