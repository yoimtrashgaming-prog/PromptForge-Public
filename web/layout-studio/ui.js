(function(){
 'use strict';
 const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
 let language=localStorage.getItem('moss-interface-language')||'en';
 const translations={
 'Compose une scène. Donne-lui des coordonnées.':'Compose a scene. Give it coordinates.',
 'Nouveau':'New','Ouvrir':'Open','Sauvegarder le projet':'Save project','Exporter le JSON ↗':'Export JSON ↗',
 'Ton canvas':'Your canvas','Largeur':'Width','Hauteur':'Height','Paysage':'Landscape','Appliquer':'Apply',
 'Dimensions de génération à reprendre dans ComfyUI.':'Use these generation dimensions in ComfyUI.',
 '02 · SCÈNE':'02 · SCENE','Prompt global':'Global prompt','Média / genre':'Medium / genre',
 '✧ Tout reformuler':'✧ Rewrite all','Tout a été reformulé. Vérifie la proposition avant de l’appliquer.':'All prompts rewritten. Review before applying.', 'Reformulation annulée.':'Rewrite cancelled.', 'Reformulation en cours…':'Rewriting…', 'Scène':'Scene','✧ Reformuler le prompt':'✧ Rewrite prompt','Exemple : pause en terrasse':'Example: terrace tea break',
 'Décris l’ambiance, le décor et le style. Qwen reformule les prompts avec le contexte de la scène.':'Describe mood, setting and style. Qwen rewrites prompts using the entire scene for context.',
 '03 · ÉLÉMENTS':'03 · ELEMENTS','＋ Objet':'＋ Element','＋ Texte':'＋ Text',
 'Les rectangles délimitent des zones de composition, pas des masques de génération.':'Boxes define composition regions, not generation masks.',
 'Sélection':'Select','Rectangle':'Rectangle','Pinceau':'Brush','Gomme':'Eraser','Ajuster':'Fit',
 'Couleur':'Color','Trait':'Size','◉ Dessin':'◉ Sketch','Effacer le dessin':'Clear sketch','Dessin privé · hors JSON MOSS':'Private sketch · excluded from MOSS JSON',
 'Image de repère':'Reference image','Retirer le repère':'Remove reference','Arrêter l’application':'Stop application',
 'INSPECTEUR':'INSPECTOR','Aucun élément sélectionné':'No element selected',
 'Sélectionne un rectangle pour définir ce qu’il représente.':'Select a box to describe what it represents.',
 'Astuce : les oiseaux, le soleil et une tasse peuvent chacun avoir leur zone.':'Tip: birds, the sun and a cup can each have their own region.',
 'Nom dans l’éditeur':'Editor name','Type':'Type','Objet / personnage / décor':'Object / character / scenery','Texte à afficher':'Visible text',
 'Prompt de l’élément':'Element prompt','Texte exact à rendre':'Exact text to render','Repère':'Guide','✧ Reformuler':'✧ Rewrite',
 'Dupliquer':'Duplicate','Supprimer':'Delete','JSON MOSS':'MOSS JSON','Copier':'Copy','Importer un JSON':'Import JSON','Télécharger':'Download',
 'Importer une composition MOSS':'Import MOSS layout',
 'Le JSON MOSS ne contient pas la taille de l’image. Indique celle utilisée pour ses coordonnées.':'MOSS JSON does not include image dimensions. Enter the size used for its coordinates.',
 'Annuler':'Cancel','Importer':'Import','Proposition Qwen':'Qwen rewrite',
 'Vérifie cette proposition avant de l’appliquer. Tu pourras l’annuler.':'Review the rewritten prompt before applying it. You can undo it.',
 'Fermer':'Close','Élément':'Element','Texte':'Text','copie':'copy','Tasse':'Cup','Soleil':'Sun','Oiseaux':'Birds',
 'Une terrasse au soleil, un personnage assis à gauche, une tasse sur la table…':'A sunny terrace, a character seated on the left, a cup on the table…',
 'Noelle assise de profil sur une chaise, tournée vers le spectateur…':'Noelle seated sideways on a chair, looking toward the viewer…',
 'Colle ton JSON MOSS ici…':'Paste your MOSS JSON here…','Canvas de composition':'Composition canvas','Zoom':'Zoom',
 'Glisse sur le canvas pour créer une zone.':'Drag on the canvas to create a region.',
 'Dessin de repère uniquement : exclu du JSON MOSS.':'Visual sketch only: excluded from MOSS JSON.',
 'Glisse un rectangle ou sa poignée pour le modifier.':'Drag a box or any of its eight handles to edit it.',
 'Sauvegarde navigateur pleine : sauvegarde le projet dans un fichier.':'Browser storage is full: save the project to a file.',
 'Maximum : 100 éléments.':'Maximum: 100 elements.','Nombre invalide.':'Invalid number.',
 'Canvas redimensionné, éléments et dessin adaptés.':'Canvas resized; boxes and sketch scaled with it.',
 'JSON copié.':'JSON copied.','Copie indisponible : utilise Télécharger.':'Clipboard unavailable: use Download.',
 'Projet sauvegardé avec ses repères et dessins.':'Project saved with its guides and sketch.',
 'Créer un nouveau projet ? Sauvegarde le projet actuel si nécessaire. Tu pourras aussi annuler.':'Create a new project? Save the current one if needed. You can also undo this action.',
 'Composition importée.':'Layout imported.','Projet limité à 20 Mo.':'Projects are limited to 20 MB.','Projet chargé.':'Project loaded.',
 'Utilise une image PNG, JPEG, WebP ou GIF de moins de 6 Mo.':'Choose a PNG, JPEG, WebP or GIF image under 6 MB.',
 'Application arrêtée. Tu peux fermer cet onglet.':'Application stopped. You can close this tab.',
 'Sélectionne un élément.':'Select an element.',
 'Le projet a changé pendant la réponse. Ferme et relance la proposition pour ne pas perdre tes modifications.':'The project changed while Qwen was responding. Close and request a new rewrite to preserve your changes.',
 'Proposition appliquée. Ctrl+Z pour annuler.':'Rewrite applied. Ctrl+Z to undo.',
 'Le projet automatique n’a pas pu être restauré. Ouvre une sauvegarde de projet.':'The autosaved project could not be restored. Open a project backup.',
 'Raccourcis':'Shortcuts','Raccourcis clavier':'Keyboard shortcuts',
 'Clique sur une touche, puis appuie sur la lettre souhaitée.':'Click a key field, then press the letter you want to use.',
 'Rétablir les touches par défaut':'Restore defaults','Terminé':'Done','Ajouter un élément':'Add element','Ajouter un texte':'Add text',
 'Modifier les couleurs':'Edit colors','Appliquer la couleur':'Apply color','Rouge':'Red','Vert':'Green','Bleu':'Blue','Teinte':'Hue','Saturation':'Saturation','Luminosité':'Brightness','RVB':'RGB',
 'Dossier des modèles':'Models folder','Modèle Qwen':'Qwen model','Langue de l’interface':'Interface language','Actualiser les modèles':'Refresh models','Charger / décharger Qwen':'Load / unload Qwen',
 'Démarrage de Qwen…':'Starting Qwen…','Recherche des modèles…':'Scanning models…','Chargement de Qwen…':'Loading Qwen…','Qwen prêt':'Qwen ready','Qwen en pause':'Qwen paused','Choisis un dossier de modèles':'Choose a model folder','Échec du chargement':'Loading failed',
 'Qwen nécessite le lanceur de l’application.':'Qwen requires the application launcher.',
 'Qwen n’est pas encore prêt.':'Qwen is not ready yet.','Écris d’abord un prompt.':'Write a prompt first.',
 'Qwen a renvoyé un prompt vide.':'Qwen returned an empty prompt.','Qwen n’a pas répondu à temps.':'Qwen did not respond in time.',
 'Utilise une couleur HEX valide.':'Use a valid HEX color.','Dimensions : multiples de 16, entre 128 et 8192 pixels.':'Dimensions must be multiples of 16, from 128 to 8192 pixels.','Cette touche est déjà utilisée.':'This key is already assigned.','Utilise une lettre ou un chiffre.':'Use a letter or a number.',
 'Ctrl+Z · Annuler':'Ctrl+Z · Undo','Ctrl+Y / Ctrl+Maj+Z · Rétablir':'Ctrl+Y / Ctrl+Shift+Z · Redo',
 'Suppr · Supprimer l’élément sélectionné':'Delete · Delete selected element','Flèches · Déplacer de 1 px / Maj · 10 px':'Arrow keys · Move 1 px / Shift · 10 px',
 'Le projet ne contient pas une taille valide.':'Project dimensions are invalid.',
 'Le dossier de modèles n’existe pas.':'Model folder does not exist.',
 'Choisis un modèle GGUF disponible.':'Choose an available GGUF model.',
 'Qwen n’est pas prêt. Attends la fin du chargement ou sélectionne un modèle.':'Qwen is not ready yet. Wait for loading to finish or select a model.',
 'Le moteur local est absent. Décompresse le ZIP entier, avec runtime/.':'Missing local engine. Extract the entire application ZIP, including runtime/.',
 'Le modèle n’a pas pu être chargé. Vérifie logs/qwen-engine.log et la mémoire disponible.':'The model could not load. Check logs/qwen-engine.log and available memory.',
 'La réponse a été coupée. Raccourcis le contexte et réessaie.':'The rewritten prompt was cut off. Shorten the scene context and try again.'
 };
 const inverse=Object.fromEntries(Object.entries(translations).map(([fr,en])=>[en,fr]));
 function t(text){if(language==='en')return translations[text]||text.replace(/^JSON exporté · utilise (.+) dans MOSS\.$/,'JSON exported · use $1 in MOSS.').replace(/^Élément (\d+) invalide\.$/,'Invalid element $1.');return inverse[text]||text}
 const staticNodes=[],attributes=[];
 function capture(){const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let n;while(n=walker.nextNode()){if(n.parentElement.closest('script,style,textarea,pre,#itemList,#boxes,#inspectorTitle,#toast,#positionInfo,#canvasInfo,#layoutWarnings,#modelStatus,#modelSelect,#shortcutRows,.colorFields label span'))continue;const raw=n.textContent;if(raw.trim())staticNodes.push([n,raw])}for(const e of $$('[placeholder],[title],[aria-label]'))for(const attr of ['placeholder','title','aria-label'])if(e.hasAttribute(attr))attributes.push([e,attr,e.getAttribute(attr)])}
 function applyStatic(){document.documentElement.lang=language;for(const [node,raw]of staticNodes){const key=raw.trim();node.textContent=raw.replace(key,t(key))}for(const [node,attr,raw]of attributes)node.setAttribute(attr,t(raw));$('#languageSelect').value=language}
 function dynamic(){for(const id of ['positionInfo','inspectorTitle','layoutWarnings']){const e=$('#'+id);if(id==='inspectorTitle'&&window.MossStudio?.selectedId())continue;e.textContent=t(e.textContent)}
  const info=$('#canvasInfo');info.textContent=info.textContent.replace(/éléments?/,'elements');if(language==='fr')info.textContent=info.textContent.replace(/elements/, 'éléments');
  const warn=$('#layoutWarnings');if(language==='en')warn.textContent=warn.textContent.replace(/(\d+) zone\(s\) sans description\. /,'$1 region(s) without a prompt. ').replace('Ajoute une description générale. ','Add a global prompt. ').replace('coordonnées centrées yxyx. Dessin et image de repère exclus.','centered yxyx coordinates. Sketch and reference image excluded.');
 }
 const defaults={select:'v',box:'r',brush:'b',eraser:'e',addObject:'a',addText:'t'};
 let keys={...defaults};try{const saved=JSON.parse(localStorage.getItem('moss-shortcuts')||'null');if(saved&&Object.keys(defaults).every(k=>/^[a-z0-9]$/.test(saved[k]))&&new Set(Object.values(saved)).size===6)keys=saved}catch{}
 const names={select:'Sélection',box:'Rectangle',brush:'Pinceau',eraser:'Gomme',addObject:'Ajouter un élément',addText:'Ajouter un texte'};
 function shortcutRows(){$('#shortcutRows').replaceChildren();for(const action of Object.keys(defaults)){const row=document.createElement('label');row.className='shortcutRow';const name=document.createElement('span');name.textContent=t(names[action]);const input=document.createElement('input');input.value=keys[action].toUpperCase();input.readOnly=true;input.dataset.shortcut=action;input.setAttribute('aria-label',t(names[action]));input.onkeydown=e=>{e.preventDefault();e.stopPropagation();const k=e.key.toLowerCase();if(!/^[a-z0-9]$/.test(k)){$('#shortcutError').textContent=t('Use a letter or a number.');return}if(Object.entries(keys).some(([a,v])=>a!==action&&v===k)){$('#shortcutError').textContent=t('This key is already assigned.');return}keys[action]=k;input.value=k.toUpperCase();$('#shortcutError').textContent='';localStorage.setItem('moss-shortcuts',JSON.stringify(keys));shortcutTitles()};row.append(name,input);$('#shortcutRows').append(row)}shortcutTitles()}
 function shortcutTitles(){for(const b of $$('[data-tool]'))b.title=t(names[b.dataset.tool])+` (${keys[b.dataset.tool].toUpperCase()})`;$('#addObject').title=t('Ajouter un élément')+` (${keys.addObject.toUpperCase()})`;$('#addText').title=t('Ajouter un texte')+` (${keys.addText.toUpperCase()})`}

 let H=0,S=1,V=1,colorTarget='brush',targetId=null;
 function rgb(h,s,v){const f=n=>{const k=(n+h/60)%6;return Math.round((v-v*s*Math.max(0,Math.min(k,4-k,1)))*255)};return[f(5),f(3),f(1)]}
 function hsv(r,g,b){r/=255;g/=255;b/=255;const max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;let h=H;if(d){if(max===r)h=60*(((g-b)/d)%6);else if(max===g)h=60*((b-r)/d+2);else h=60*((r-g)/d+4)}return[(h+360)%360,max?d/max:0,max]}
 const hex=values=>'#'+values.map(v=>Math.round(v).toString(16).padStart(2,'0')).join('');
 function colorSync(){const c=rgb(H,S,V),value=hex(c);$('#colorSample').style.background=value;$('#colorHex').value=value;$('#colorBrightness').value=Math.round(V*100);$('#colorBrightness').style.background=`linear-gradient(to top,black,${hex(rgb(H,S,1))})`;$('#colorMarker').style.left=`${H/360*100}%`;$('#colorMarker').style.top=`${(1-S)*100}%`;const rgbMode=$('#colorMode').value==='rgb';const values=rgbMode?c:[Math.round(H),Math.round(S*100),Math.round(V*100)];const labels=rgbMode?['Red','Green','Blue']:['Hue','Saturation','Brightness'];values.forEach((v,n)=>{const input=$('#colorN'+n);input.max=rgbMode?255:n===0?360:100;input.value=v;$('#colorLabel'+n).textContent=t(labels[n])})}
 function openColor(target){colorTarget=target;targetId=window.MossStudio.selectedId();const value=$('#'+(target==='brush'?'brushColor':'itemColor')).value;[H,S,V]=hsv(...value.slice(1).match(/../g).map(x=>parseInt(x,16)));$('#colorError').textContent='';colorSync();$('#colorDialog').showModal()}
 function initColors(){const canvas=$('#colorPlane'),ctx=canvas.getContext('2d'),data=ctx.createImageData(256,256);for(let y=0;y<256;y++)for(let x=0;x<256;x++){const c=rgb(x/256*360,1-y/255,1),i=(y*256+x)*4;data.data.set([...c,255],i)}ctx.putImageData(data,0,0);
  let drag=false;const pick=e=>{const b=canvas.getBoundingClientRect();H=Math.max(0,Math.min(359.99,(e.clientX-b.left)/b.width*360));S=1-Math.max(0,Math.min(1,(e.clientY-b.top)/b.height));colorSync()};canvas.onpointerdown=e=>{drag=true;canvas.setPointerCapture(e.pointerId);pick(e)};canvas.onpointermove=e=>{if(drag)pick(e)};canvas.onpointerup=()=>drag=false;canvas.onpointercancel=()=>drag=false;
  $('#brushPicker').onclick=()=>openColor('brush');$('#itemPicker').onclick=()=>openColor('item');$('#cancelColor').onclick=()=>$('#colorDialog').close();$('#colorBrightness').oninput=()=>{V=Number($('#colorBrightness').value)/100;colorSync()};$('#colorMode').onchange=colorSync;
  $('#colorHex').onchange=()=>{let v=$('#colorHex').value.trim().replace(/^#/,'');if(/^[0-9a-f]{3}$/i.test(v))v=v.split('').map(x=>x+x).join('');if(!/^[0-9a-f]{6}$/i.test(v)){$('#colorError').textContent=t('Use a valid HEX color.');return}$('#colorError').textContent='';[H,S,V]=hsv(...v.match(/../g).map(x=>parseInt(x,16)));colorSync()};
  for(let n=0;n<3;n++)$('#colorN'+n).onchange=()=>{const rgbMode=$('#colorMode').value==='rgb',values=[0,1,2].map(i=>Math.max(0,Math.min(rgbMode?255:i===0?360:100,Number($('#colorN'+i).value)||0)));if(rgbMode)[H,S,V]=hsv(...values);else[H,S,V]=[values[0]%360,values[1]/100,values[2]/100];colorSync()};
  $('#applyColor').onclick=()=>{if($('#colorError').textContent)return;const value=hex(rgb(H,S,V));if(colorTarget==='brush'){$('#brushColor').value=value;$('#brushPicker').style.background=value}else window.MossStudio.applyItemColor(targetId,value);$('#colorDialog').close()};
  $('#brushColor').addEventListener('change',()=>$('#brushPicker').style.background=$('#brushColor').value);for(const b of $$('[data-swatch]'))b.addEventListener('click',()=>$('#brushPicker').style.background=b.dataset.swatch);
 }

 let state={phase:'idle',selected:'',models:[]},pollTimer;
 function modelStatus(){const select=$('#modelSelect');const options=state.models.map(m=>[m.id,m.name]);if(select.dataset.options!==JSON.stringify(options)){select.replaceChildren();for(const [id,name]of options){const o=document.createElement('option');o.value=id;o.textContent=name;select.append(o)}if(!options.length){const o=document.createElement('option');o.value='';o.textContent=t('Choose a model folder');select.append(o)}select.dataset.options=JSON.stringify(options)}select.value=state.selected;const labels={ready:'Qwen ready',loading:'Loading Qwen…',paused:'Qwen paused',error:'Loading failed',idle:state.models.length?'Qwen paused':'Choose a model folder'};$('#modelStatus').textContent=t(labels[state.phase]||'Starting Qwen…');$('#modelStatus').className='modelStatus '+state.phase;$('#modelStatus').title=state.error?t(state.error):state.folder||'';$('#modelPower').disabled=!state.selected;}
 async function api(path,body={}){return window.MossStudio.api(path,body)}
 async function poll(){try{state=await api('/api/model/status');modelStatus()}catch(e){$('#modelStatus').textContent=t(e.message)}finally{pollTimer=setTimeout(poll,state.phase==='loading'?1000:3500)}}
 function initModels(){if(location.protocol==='file:'){$('#modelStatus').textContent=t('Qwen requires the application launcher.');$('#modelSelect').disabled=true;return}poll();$('#modelSelect').onchange=async()=>{try{state=await api('/api/model/load',{id:$('#modelSelect').value});modelStatus()}catch(e){window.MossStudio.notify(e.message)}};$('#modelRefresh').onclick=async()=>{try{state=await api('/api/model/refresh');modelStatus()}catch(e){window.MossStudio.notify(e.message)}};$('#modelFolder').onclick=async()=>{const b=$('#modelFolder');b.disabled=true;try{state=await api('/api/model/folder');modelStatus();if(state.error)window.MossStudio.notify(state.error)}catch(e){window.MossStudio.notify(e.message)}finally{b.disabled=false}};$('#modelPower').onclick=async()=>{try{state=await api(state.phase==='ready'||state.phase==='loading'?'/api/model/stop':'/api/model/load',{id:state.selected});modelStatus()}catch(e){window.MossStudio.notify(e.message)}};}
 window.MossUI={t,dynamic,actionForKey:key=>Object.entries(keys).find(([,v])=>v===key.toLowerCase())?.[0],modelReady:()=>true};
 document.addEventListener('DOMContentLoaded',()=>{capture();applyStatic();shortcutRows();initColors();$('#languageSelect').onchange=()=>{language=$('#languageSelect').value;localStorage.setItem('moss-interface-language',language);applyStatic();shortcutRows();colorSync();window.dispatchEvent(new Event('moss-language'));dynamic()};$('#shortcutsButton').onclick=()=>{shortcutRows();$('#shortcutError').textContent='';$('#shortcutsDialog').showModal()};$('#closeShortcuts').onclick=()=>$('#shortcutsDialog').close();$('#resetShortcuts').onclick=()=>{keys={...defaults};localStorage.setItem('moss-shortcuts',JSON.stringify(keys));shortcutRows();$('#shortcutError').textContent=''};new ResizeObserver(()=>document.documentElement.style.setProperty('--header-height',$('header').offsetHeight+'px')).observe($('header'));dynamic()});
})();
