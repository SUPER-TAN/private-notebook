'use strict';
(() => {
 const $ = id => document.getElementById(id);
 const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
 const base = String(window.NOTEBOOK_CONFIG?.apiBase || '').replace(/\/+$/, '');
 const colors = ['#81976a','#8b9eae','#bd987b','#a390b4','#baaa66','#789e98'];
 const state = {token:sessionStorage.getItem('zhiye-token') || '', notebooks:[], pages:[], notebookId:null, page:null, dirty:false, version:0, savePromise:null, timer:null, imageUrls:new Map(), pending:new Set(), selection:null, composing:false, error:null};
 let modalResolve = null;
 let navigationTail = Promise.resolve();
 let searchTimer, searchVersion=0, searchResults=null, searchQuery='';

 async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.token) headers.set('Authorization', 'Bearer ' + state.token);
  if (options.json !== undefined) { headers.set('Content-Type','application/json'); options.body=JSON.stringify(options.json); }
  let response;
  try { response=await fetch(base + '/api' + path, {...options, signal:options.signal||AbortSignal.timeout(45000), headers, credentials:base?'omit':'same-origin', cache:'no-store'}); }
  catch { throw new Error('暂时无法连接笔记服务。请检查网络，内容仍保留在当前页面。'); }
  if (!response.ok) { const body=await response.json().catch(()=>({})); const error=new Error(body.error?.message || body.error || body.message || `请求失败（${response.status}）`); error.status=response.status; error.details=body; throw error; }
  return options.blob ? response.blob() : response.json();
 }
 function toast(message, error=false) {const node=document.createElement('div'); node.className='toast'+(error?' error':'');node.textContent=message;$('toasts').append(node);setTimeout(()=>node.remove(),error?8000:4200);}
 function failure(error) {toast(error.message || '操作失败，请重试。',true);}
 function run(fn) {return (...args)=>Promise.resolve().then(()=>fn(...args)).catch(failure);}
 function runNavigation(fn, save=true) {return run((...args)=>navigate(()=>fn(...args),save));}
 function dateText(date, full=false) {if(!date)return '';const d=new Date(date); if(Number.isNaN(d.getTime()))return ''; return full? d.toLocaleString('zh-CN',{year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'}):d.toLocaleDateString('zh-CN',{month:'2-digit',day:'2-digit'});}
 function notebook(id) {return state.notebooks.find(n=>n.id===id);}
 function setSave(text, status='') {$('save-status').textContent=text;$('save-status').className='save-status '+status;}
 function cleanupImages() {for(const url of state.imageUrls.values()) URL.revokeObjectURL(url);state.imageUrls.clear();}
 function countWords() {$('word-count').textContent=$('editor').innerText.replace(/\s/g,'').length.toLocaleString()+' 字';}
 function imagePath(src) {return /^\/api\/images\/[a-zA-Z0-9-]+$/.test(src||'');}
 function serialize() {const copy=$('editor').cloneNode(true);for(const img of copy.querySelectorAll('img')) { const source=img.dataset.image || img.getAttribute('src'); if(imagePath(source)) {img.setAttribute('src',source); img.removeAttribute('data-image');img.removeAttribute('data-image-error');} else img.replaceWith(document.createTextNode('[图片未保存，请重新插入]')); }return copy.innerHTML;}
 function markDirty() {if(!state.page)return;state.dirty=true;state.version++;state.error=null;setSave('尚未保存','pending');countWords();clearTimeout(state.timer);if(!state.composing)state.timer=setTimeout(()=>flush().catch(()=>{}),900);}
 async function flush() {
  clearTimeout(state.timer);
  if(state.savePromise) {await state.savePromise;if(state.dirty)return flush();return;}
  if(!state.page||!state.dirty)return;
  const id=state.page.id,version=state.version,title=$('page-title').value.trim()||'无标题书页',html=serialize(),revision=state.page.revision;
  setSave('正在保存…','pending');
  state.savePromise=(async()=>{
   try {const saved=await api('/pages/'+id,{method:'PUT',json:{title,html,revision}});if(state.page?.id!==id)return;state.page={...state.page,...saved};state.dirty=state.version!==version;state.error=null;const item=state.pages.find(p=>p.id===id);if(item)Object.assign(item,saved,{excerpt:$('editor').innerText.slice(0,180)});renderPages();setSave(state.dirty?'尚未保存':'已保存',state.dirty?'pending':'');$('document-date').textContent='编辑于 '+dateText(saved.updatedAt,true);}
   catch(error) {state.error=error;setSave(error.status===409?'内容冲突 · 点此处理':error.status===401?'登录过期 · 点此登录':'保存失败 · 点此重试','error');$('storage-label').textContent='当前修改尚未保存，请保持此页面打开';throw error;}
   finally {state.savePromise=null;}
  })();
  await state.savePromise;
  if(!state.dirty)$('storage-label').textContent='自动保存已开启';
  if(state.dirty)return flush();
 }
 async function waitPending(){while(state.pending.size)await Promise.all([...state.pending]);}
 async function safeLeave(){await waitPending();await flush();}
 function lockEditor(locked){state.editorLocked=locked;$('editor').contentEditable=String(!locked);$('editor').setAttribute('aria-busy',String(locked));$('page-title').disabled=locked;document.querySelectorAll('.toolbar button,.toolbar select').forEach(control=>control.disabled=locked);$('workspace').classList.toggle('busy',locked);}
 function navigate(action,save=true){const task=navigationTail.catch(()=>{}).then(async()=>{await waitPending();lockEditor(true);try{if(save)await flush();return await action();}finally{lockEditor(false);}});navigationTail=task;return task;}
 function tracked(task) {state.pending.add(task); task.finally(()=>state.pending.delete(task)).catch(()=>{});return task;}
 function renderNotebooks() {
  $('total-count').textContent=state.pages.length;
  $('all-notes').classList.toggle('active',!state.notebookId);
  $('notebook-list').innerHTML=state.notebooks.map(n=>`<button class="nav-item ${n.id===state.notebookId?'active':''}" data-notebook="${esc(n.id)}"><span class="notebook-dot" style="background:${/^#[0-9a-f]{6}$/i.test(n.color)?n.color:colors[0]}"></span><span class="notebook-name">${esc(n.name)}</span><span class="count">${state.pages.filter(p=>p.notebookId===n.id).length}</span></button>`).join('');
  $('collection-title').textContent=state.notebookId?notebook(state.notebookId)?.name||'笔记本':'全部书页';
  $('notebook-options').hidden=!state.notebookId;
 }
 function renderPages() {
  const query=$('search').value.trim().toLowerCase();
  const source=query&&query===searchQuery&&searchResults?searchResults:state.pages;
  let pages=source.filter(p=>(!state.notebookId||p.notebookId===state.notebookId)&&(!query||query===searchQuery&&searchResults||(p.title+' '+(p.excerpt||'')).toLowerCase().includes(query)));
  pages=pages.sort((a,b)=>new Date(b.updatedAt)-new Date(a.updatedAt));
  $('page-count').textContent=pages.length+' 个书页';
  $('page-list').innerHTML=pages.length? pages.map(p=>`<button class="page-card ${p.id===state.page?.id?'active':''}" data-page="${esc(p.id)}"><h3>${icon('file')}<span>${esc(p.title||'无标题书页')}</span></h3><p>${esc(p.excerpt||'还没有内容，写下第一句话…')}</p><footer><span>${dateText(p.updatedAt)}</span><span>${esc(notebook(p.notebookId)?.name||'笔记')}</span></footer></button>`).join(''):`<div class="no-pages">${query?'没有找到相关书页<br>试试其他关键词':'这里还没有书页<br>点击上方开始记录'}</div>`;
 }
 async function refresh(){const data=await api('/notebooks');state.notebooks=data.notebooks;state.pages=data.pages;renderNotebooks();renderPages();}
 async function selectNotebook(id) {await safeLeave();state.notebookId=id;$('search').value='';renderNotebooks();renderPages();const first=state.pages.filter(p=>!id||p.notebookId===id).sort((a,b)=>new Date(b.updatedAt)-new Date(a.updatedAt))[0];if(first)await openPage(first.id,false);else showEmpty();}
 function showEmpty() {state.page=null;state.dirty=false;$('document-view').hidden=true;$('empty-view').hidden=false;$('page-options').hidden=true;$('breadcrumb-title').textContent=notebook(state.notebookId)?.name||'开始记录';$('page-title').value='';$('editor').replaceChildren();setSave('已保存');renderPages();}
 async function hydrateImages(container, pageId) {
  await Promise.all([...container.querySelectorAll('img')].map(async img=>{
   const path=img.getAttribute('src');if(!imagePath(path)){img.remove();return;}img.dataset.image=path;img.removeAttribute('src');img.alt=img.alt||'笔记图片';
   try {let url=state.imageUrls.get(path);if(!url){const blob=await api(path.slice(4),{blob:true});url=URL.createObjectURL(blob);state.imageUrls.set(path,url);}if(state.page?.id===pageId&&img.isConnected)img.src=url;}
   catch {if(img.isConnected){img.alt='图片加载失败；重新打开书页可重试';img.dataset.imageError='true';toast('一张图片未能加载，请检查网络后重新打开书页。',true);}}
  }));
 }
 async function openPage(id, closeNav=true) {
  await safeLeave();const page=await api('/pages/'+id);state.page=page;state.dirty=false;state.version=0;state.error=null;
  $('page-title').value=page.title;$('editor').innerHTML=sanitize(page.html||'');$('document-view').hidden=false;$('empty-view').hidden=true;$('page-options').hidden=false;
  $('document-notebook').textContent=notebook(page.notebookId)?.name||'笔记';$('breadcrumb-title').textContent=notebook(page.notebookId)?.name||'笔记';$('document-date').textContent='编辑于 '+dateText(page.updatedAt,true);$('storage-label').textContent='自动保存已开启';setSave('已保存');countWords();renderPages();
  if(closeNav)$('workspace').classList.remove('nav-open');await hydrateImages($('editor'),id);
 }
 async function enterWorkspace() {await refresh();$('login-view').hidden=true;$('workspace').hidden=false;if(state.pages.length)await openPage([...state.pages].sort((a,b)=>new Date(b.updatedAt)-new Date(a.updatedAt))[0].id);else showEmpty();}
 async function login(password) {const data=await api('/login',{method:'POST',json:{password}});state.token=data.token||'';if(state.token)sessionStorage.setItem('zhiye-token',state.token);}
 $('login-form').addEventListener('submit',async event=>{event.preventDefault();$('login-error').textContent='';$('login-submit').disabled=true;try {await login($('password').value);$('password').value='';await navigate(enterWorkspace);}catch(error){$('login-error').textContent=error.status===401?'密码不正确，请重新输入。':error.message;}finally{$('login-submit').disabled=false;}});
 $('toggle-password').onclick=()=>{const show=$('password').type==='password';$('password').type=show?'text':'password';$('toggle-password').textContent=show?'隐藏':'显示';};

 function finishDialog(value) {const done=modalResolve;modalResolve=null;$('dialog').close();if(done)done(value);}
 function dialog(title, html, confirm='确定', init) {
  if(modalResolve)finishDialog(null);
  $('dialog-title').textContent=title;$('dialog-body').innerHTML=html;$('dialog-confirm').textContent=confirm;$('dialog-error').textContent='';$('dialog-cancel').hidden=false;$('dialog-confirm').hidden=false;
  return new Promise(resolve=>{modalResolve=resolve;$('dialog').showModal();if(init)init($('dialog-body'));setTimeout(()=>$('dialog-body').querySelector('input:not([type=radio]),select')?.focus(),30);});
 }
 $('dialog-form').onsubmit=event=>{event.preventDefault();finishDialog(new FormData(event.currentTarget));};
 $('dialog-close').onclick=()=>finishDialog(null);$('dialog-cancel').onclick=()=>finishDialog(null);$('dialog').addEventListener('cancel',event=>{event.preventDefault();finishDialog(null);});
 const textField=(label,name,value='',type='text',extra='')=>`<label class="dialog-field">${label}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
 const colorFields=color=>`<span class="dialog-field">笔记本颜色</span><div class="color-options">${colors.map((c,i)=>`<label><input type="radio" name="color" value="${c}" ${c===(color||colors[0])?'checked':''} aria-label="颜色 ${i+1}"><span class="color-swatch" style="background:${c}"></span></label>`).join('')}</div>`;
 async function newNotebook() {await safeLeave();const form=await dialog('新建专业笔记本',textField('笔记本名称','name','','text','required maxlength="60" placeholder="例如：电子硬件、机器人导航"')+colorFields(),'创建笔记本');if(!form)return null;const created=await api('/notebooks',{method:'POST',json:{name:String(form.get('name')).trim(),color:form.get('color')}});await refresh();state.notebookId=created.id;renderNotebooks();renderPages();showEmpty();return created;}
 async function newPage() {await safeLeave();if(!state.notebooks.length){const n=await newNotebook();if(!n)return;}let id=state.notebookId;if(!id){if(state.notebooks.length===1)id=state.notebooks[0].id;else{const form=await dialog('新建书页',`<label class="dialog-field">放入哪个笔记本<select name="notebookId">${state.notebooks.map(n=>`<option value="${esc(n.id)}">${esc(n.name)}</option>`).join('')}</select></label>`,'创建书页');if(!form)return;id=form.get('notebookId');}}const p=await api('/pages',{method:'POST',json:{notebookId:id,title:'无标题书页'}});state.notebookId=id;await refresh();await openPage(p.id);$('page-title').focus();$('page-title').select();}
 $('add-notebook').onclick=runNavigation(newNotebook);$('add-page').onclick=runNavigation(newPage);$('empty-add-page').onclick=runNavigation(newPage);
 $('all-notes').onclick=runNavigation(()=>selectNotebook(null));$('notebook-list').onclick=runNavigation(event=>{const button=event.target.closest('[data-notebook]');if(button)return selectNotebook(button.dataset.notebook);});$('page-list').onclick=runNavigation(event=>{const button=event.target.closest('[data-page]');if(button)return openPage(button.dataset.page);});
 $('search').oninput=()=>{state.notebookId=null;searchResults=null;searchQuery='';const query=$('search').value.trim().toLowerCase(),version=++searchVersion;clearTimeout(searchTimer);renderNotebooks();renderPages();if(query)searchTimer=setTimeout(async()=>{try{const data=await api('/search?q='+encodeURIComponent(query));if(version!==searchVersion||$('search').value.trim().toLowerCase()!==query)return;searchResults=data.pages;searchQuery=query;renderPages();}catch(error){if(version===searchVersion)failure(error);}},250);};$('mobile-menu').onclick=()=>$('workspace').classList.toggle('nav-open');
 $('notebook-options').onclick=runNavigation(async()=>{const n=notebook(state.notebookId);if(!n)return;await safeLeave();const form=await dialog('管理笔记本',textField('笔记本名称','name',n.name,'text','required maxlength="60"')+colorFields(n.color)+`<button type="button" class="setting-row danger" id="delete-notebook">${icon('trash')}删除整个笔记本…</button>`,'保存',()=>{$('delete-notebook').onclick=run(async()=>{finishDialog(null);const confirmation=await dialog('删除笔记本',`<p class="dialog-copy">将删除「${esc(n.name)}」及其中的 ${state.pages.filter(p=>p.notebookId===n.id).length} 个书页。此操作无法撤销，建议先导出备份。</p>`+textField('输入笔记本名称确认','confirm','','text','required'),'删除');if(!confirmation)return;if(confirmation.get('confirm')!==n.name)throw new Error('名称不一致，已取消删除。');await navigate(async()=>{await api('/notebooks/'+n.id,{method:'DELETE'});state.page=null;state.dirty=false;state.notebookId=null;await refresh();showEmpty();toast('笔记本已删除');});});});if(!form)return;await api('/notebooks/'+n.id,{method:'PATCH',json:{name:form.get('name'),color:form.get('color')}});await refresh();if(state.page){$('document-notebook').textContent=notebook(state.page.notebookId)?.name;$('breadcrumb-title').textContent=notebook(state.page.notebookId)?.name;}});

 function rememberSelection(){const selection=window.getSelection();if(selection.rangeCount&&$('editor').contains(selection.anchorNode))state.selection=selection.getRangeAt(0).cloneRange();}
 function restoreSelection(){const selection=window.getSelection();$('editor').focus();selection.removeAllRanges();if(state.selection&&$('editor').contains(state.selection.commonAncestorContainer))selection.addRange(state.selection);else{const r=document.createRange();r.selectNodeContents($('editor'));r.collapse(false);selection.addRange(r);}}
 function insertHTML(html){restoreSelection();document.execCommand('insertHTML',false,html);rememberSelection();markDirty();}
 document.addEventListener('selectionchange',rememberSelection);
 document.querySelectorAll('[data-command]').forEach(button=>{button.onmousedown=event=>event.preventDefault();button.onclick=()=>{restoreSelection();document.execCommand(button.dataset.command,false,null);rememberSelection();markDirty();};});
 $('block-format').onchange=()=>{restoreSelection();document.execCommand('formatBlock',false,$('block-format').value);rememberSelection();markDirty();};
 $('editor').addEventListener('input',markDirty);$('page-title').addEventListener('input',markDirty);
 for(const input of [$('editor'),$('page-title')]){input.addEventListener('compositionstart',()=>{state.composing=true;clearTimeout(state.timer);});input.addEventListener('compositionend',()=>{state.composing=false;markDirty();});}
 $('insert-link').onmousedown=event=>event.preventDefault();$('insert-link').onclick=run(async()=>{rememberSelection();const form=await dialog('插入链接',textField('网页地址','url','','url','required placeholder="https://…"'),'插入');if(!form)return;const url=String(form.get('url')).trim();if(!/^https?:\/\//i.test(url))throw new Error('请输入以 https:// 或 http:// 开头的网址。');restoreSelection();if(window.getSelection().isCollapsed)insertHTML(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`);else{document.execCommand('createLink',false,url);markDirty();}});
 const blocked=new Set(['SCRIPT','STYLE','IFRAME','OBJECT','EMBED','SVG','MATH','FORM','INPUT','BUTTON','TEXTAREA','SELECT','META','LINK','BASE','TEMPLATE','NOSCRIPT']);
 const allowed=new Set(['P','BR','STRONG','B','EM','I','U','S','DEL','H1','H2','H3','H4','H5','H6','UL','OL','LI','BLOCKQUOTE','PRE','CODE','TABLE','THEAD','TBODY','TFOOT','TR','TD','TH','HR','MARK','SUB','SUP']);
 function sanitize(input, images=false){
  const doc=new DOMParser().parseFromString(input,'text/html');const output=document.createElement('div');
  function visit(node,parent){if(node.nodeType===3){parent.append(document.createTextNode(node.textContent));return;}if(node.nodeType!==1||blocked.has(node.tagName))return;
   const tag=node.tagName;
   if(tag==='IMG'){const src=node.getAttribute('src')||'';if(imagePath(src)||(images&&/^(data:image\/(png|jpeg|webp|gif);base64,|https?:\/\/|blob:)/i.test(src))){const el=document.createElement('img');el.setAttribute('src',src);el.alt=(node.getAttribute('alt')||'图片').slice(0,200);parent.append(el);}return;}
   if(tag==='A'){const href=node.getAttribute('href')||'';if(/^https?:\/\//i.test(href)){const el=document.createElement('a');el.href=href;el.target='_blank';el.rel='noopener noreferrer';parent.append(el);for(const child of node.childNodes)visit(child,el);}else for(const child of node.childNodes)visit(child,parent);return;}
   let target=parent;
   if(allowed.has(tag)||tag==='DIV'){target=document.createElement(tag==='DIV'?'p':tag.toLowerCase());if(tag==='TD'||tag==='TH')for(const attr of ['colspan','rowspan']){const n=Number(node.getAttribute(attr));if(n>1&&n<=20)target.setAttribute(attr,String(n));}parent.append(target);}
   else if(tag==='SPAN'){if(node.style.fontWeight==='bold'||Number(node.style.fontWeight)>=600){target=document.createElement('strong');parent.append(target);}if(node.style.fontStyle==='italic'){const el=document.createElement('em');target.append(el);target=el;}}
   for(const child of node.childNodes)visit(child,target);
  }
  for(const child of doc.body.childNodes)visit(child,output);return output.innerHTML;
 }
 async function prepareImage(file){
  if(!/^image\/(png|jpeg|webp|gif)$/.test(file.type))throw new Error('支持 PNG、JPG、WebP 和 GIF 图片。');
  if(file.size>25*1024*1024)throw new Error('原始图片超过 25 MB，请先缩小后再插入。');
  if(file.size<=1024*1024)return file;
  const bitmap=await createImageBitmap(file);if(bitmap.width*bitmap.height>80e6){bitmap.close();throw new Error('图片尺寸过大，请先缩小。');}
  const canvas=document.createElement('canvas');let ratio=Math.min(1,2200/Math.max(bitmap.width,bitmap.height));
  let result;for(let i=0;i<7;i++){canvas.width=Math.max(1,Math.round(bitmap.width*ratio));canvas.height=Math.max(1,Math.round(bitmap.height*ratio));canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);result=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',Math.max(.55,.9-i*.05)));if(result&&result.size<=1024*1024)break;ratio*=.8;}
  bitmap.close();if(!result||result.size>1024*1024)throw new Error('图片压缩后仍然太大，请换一张较小的图片。');if(file.type==='image/gif')toast('GIF 较大，已作为静态图片插入。');else toast('大图片已压缩，便于保存与加载。');return result;
 }
 async function uploadImage(file){const blob=await prepareImage(file);const data=await api('/images',{method:'POST',headers:{'Content-Type':blob.type},body:blob});const path=data.url;if(!imagePath(path))throw new Error('图片服务返回了无效地址。');const url=URL.createObjectURL(blob);state.imageUrls.set(path,url);return {path,url};}
 async function insertFiles(files){const id=state.page?.id;if(!id)return;if(state.editorLocked)throw new Error('正在切换书页，请稍后重新插入图片。');rememberSelection();setSave('正在上传图片…','pending');for(const file of files){const image=await uploadImage(file);if(state.page?.id!==id)throw new Error('书页已切换，请重新插入图片。');insertHTML(`<p><img src="${esc(image.url)}" data-image="${esc(image.path)}" alt="${esc(file.name||'粘贴的图片')}"></p><p><br></p>`);}markDirty();}
 $('insert-image').onmousedown=event=>event.preventDefault();$('insert-image').onclick=()=>{rememberSelection();$('image-input').click();};$('image-input').onchange=run(async()=>{const files=[...$('image-input').files];$('image-input').value='';await tracked(insertFiles(files));});
 async function paste(event){
   const clipboard=event.clipboardData;if(!clipboard)return;event.preventDefault();const pageId=state.page?.id;if(!pageId||state.editorLocked)return;rememberSelection();
  const files=[...clipboard.items].filter(item=>item.kind==='file'&&item.type.startsWith('image/')).map(item=>item.getAsFile()).filter(Boolean),html=clipboard.getData('text/html'),text=clipboard.getData('text/plain');
  if(!html){if(text)insertHTML(text.split(/\r?\n/).map(line=>`<p>${esc(line)||'<br>'}</p>`).join(''));if(files.length)await insertFiles(files);return;}
  const container=document.createElement('div');container.innerHTML=sanitize(html,true);const images=[...container.querySelectorAll('img')];let fallback=0,missing=0;
  if(images.length)setSave('正在保存粘贴的图片…','pending');
  for(const img of images){try{const src=img.getAttribute('src');if(imagePath(src)){const result=await api(src.slice(4),{blob:true});const local=await uploadImage(result);img.src=local.url;img.dataset.image=local.path;continue;}let file;if(files[fallback])file=files[fallback++];else {const response=await fetch(src,{credentials:'omit',signal:AbortSignal.timeout(12000)});if(!response.ok)throw new Error('unavailable');file=await response.blob();}const uploaded=await uploadImage(file);img.src=uploaded.url;img.dataset.image=uploaded.path;}catch{const p=document.createElement('p');p.textContent='[此图片未能复制，请在飞书中单独复制图片后粘贴，或使用“图片”按钮上传]';img.replaceWith(p);missing++;}}
   if(state.page?.id!==pageId)throw new Error('书页已切换，请在目标书页重新粘贴。');
   insertHTML(container.innerHTML);
  if(!images.length&&files.length)await insertFiles(files);
  if(missing)toast(`${missing} 张图片无法直接复制，已在对应位置标记，文字已保留。`,true);
 }
 $('editor').addEventListener('paste',event=>{tracked(paste(event)).catch(failure);});
 $('editor').addEventListener('dragover',event=>event.preventDefault());$('editor').addEventListener('drop',event=>{event.preventDefault();const files=[...event.dataTransfer.files].filter(f=>f.type.startsWith('image/'));if(files.length)tracked(insertFiles(files)).catch(failure);});

 function download(data,name,type='application/json'){const url=URL.createObjectURL(new Blob([data],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);}
 async function backup(){await safeLeave();const form=await dialog('导出完整备份','<div class="dialog-copy"><p>下载所有笔记本、书页和图片，可在另一套知页中导入恢复。</p><p><strong>备份文件没有加密，包含你的全部笔记。</strong>请保存在自己的安全位置，不要上传到公开 GitHub 仓库。</p></div>','下载备份');if(!form)return;setSave('正在导出…','pending');try{const data=await api('/export');download(JSON.stringify(data),`知页备份-${new Date().toISOString().slice(0,10)}.json`);toast('完整备份已下载');}finally{setSave('已保存');}}
 $('backup-button').onclick=runNavigation(backup);
 $('import-input').onchange=run(async()=>{const file=$('import-input').files[0];$('import-input').value='';if(!file)return;if(file.size>64*1024*1024)throw new Error('备份文件超过 64 MB，请拆分后再导入。');const backup=JSON.parse(await file.text());await navigate(async()=>{const form=await dialog('导入备份','<div class="dialog-copy"><p>备份内容将作为新的笔记本添加，现有笔记不会被覆盖。重复导入会产生多份内容。</p></div>','开始导入');if(!form)return;await safeLeave();const result=await api('/import',{method:'POST',json:{backup}});await refresh();toast(`已导入 ${result.imported?.pages||0} 个书页`);});});
 $('settings-button').onclick=runNavigation(async()=>{await safeLeave();dialog('设置与安全',`<div class="dialog-copy"><p>文字和图片保存于${base?'你配置的云端笔记服务':'当前笔记服务'}，登录会话到期后需要重新输入密码。</p></div><button type="button" class="setting-row" id="change-password">${icon('lock')}修改访问密码</button><button type="button" class="setting-row" id="restore-backup">${icon('up')}导入笔记备份</button><button type="button" class="setting-row" id="clean-images">${icon('trash')}清理未使用的图片</button><div class="dialog-copy"><p>图片会自动压缩到单张 1 MB 以内；当前版本图片总容量为 40 MB。重要笔记建议定期导出备份。</p></div>`,'完成',()=>{$('restore-backup').onclick=()=>{finishDialog(null);$('import-input').click();};$('clean-images').onclick=runNavigation(async()=>{finishDialog(null);const form=await dialog('清理未使用的图片','<div class="dialog-copy"><p>只清理上传超过 24 小时、且所有已保存书页都没有使用的图片。正在使用的图片会保留。</p><p>请先保存其他设备正在编辑的书页。清理后不能撤销。</p></div>','开始清理');if(!form)return;const result=await api('/images/cleanup',{method:'POST',json:{}});toast(`清理了 ${result.removed} 张图片，释放 ${(result.freedBytes/1024/1024).toFixed(2)} MB。`);});$('change-password').onclick=runNavigation(async()=>{finishDialog(null);const form=await dialog('修改访问密码',textField('当前密码','current','','password','required autocomplete="current-password"')+textField('新密码','next','','password','required autocomplete="new-password"')+textField('再次输入新密码','repeat','','password','required autocomplete="new-password"'),'修改密码');if(!form)return;if(form.get('next')!==form.get('repeat'))throw new Error('两次新密码不一致，请重新输入。');await api('/password',{method:'POST',json:{currentPassword:form.get('current'),newPassword:form.get('next')}});clearSession();toast('密码已修改，请使用新密码重新登录。');});});});
 function clearSession(){state.token='';sessionStorage.removeItem('zhiye-token');searchVersion++;clearTimeout(searchTimer);searchResults=null;searchQuery='';state.notebooks=[];state.pages=[];state.notebookId=null;state.page=null;state.dirty=false;state.selection=null;cleanupImages();$('editor').replaceChildren();$('page-title').value='';$('notebook-list').replaceChildren();$('page-list').replaceChildren();$('search').value='';$('workspace').hidden=true;$('login-view').hidden=false;$('password').value='';$('password').focus();}
 $('logout').onclick=runNavigation(async()=>{await safeLeave();await api('/logout',{method:'POST',json:{}});clearSession();toast('已安全退出');});
 $('help-button').onclick=()=>dialog('使用知页',`<div class="dialog-copy"><p><strong>按专业整理</strong><br>点击左侧「＋」新建笔记本，再添加书页。标题和正文会自动保存。</p><p><strong>文字与图片</strong><br>直接输入或粘贴内容，用工具栏调整标题、加粗、列表和链接。截图可直接 Ctrl+V，也可以拖入图片。</p><p><strong>从飞书复制</strong><br>支持常见文字、标题、列表和表格。受飞书权限或浏览器限制的图片会显示提示，单独复制图片补上即可。复杂白板、附件和嵌入卡片需要另行整理。</p><p><strong>随时带走</strong><br>「导出备份」包含全部文字和图片。「设置与安全」可以导入备份、更改密码。</p><p><strong>快捷键</strong><br>Ctrl+S 保存 · Ctrl+B 加粗 · Ctrl+Z 撤销<br>在编辑区外按 / 搜索书页。</p></div>`,'知道了');
 $('page-options').onclick=runNavigation(async()=>{if(!state.page)return;await safeLeave();dialog('书页操作',`<button type="button" class="setting-row" id="print-page">${icon('file')}打印 / 另存为 PDF</button><button type="button" class="setting-row" id="copy-page">${icon('plus')}创建副本</button><button type="button" class="setting-row danger" id="delete-page">${icon('trash')}删除此书页…</button>`,'完成',()=>{$('print-page').onclick=()=>{finishDialog(null);window.print();};$('copy-page').onclick=runNavigation(async()=>{finishDialog(null);const current=state.page;const created=await api('/pages',{method:'POST',json:{notebookId:current.notebookId,title:(current.title+'（副本）').slice(0,160)}});await api('/pages/'+created.id,{method:'PUT',json:{title:(current.title+'（副本）').slice(0,160),html:serialize(),revision:created.revision}});await refresh();await openPage(created.id);});$('delete-page').onclick=runNavigation(async()=>{const id=state.page.id,title=state.page.title;finishDialog(null);const form=await dialog('删除书页',`<p class="dialog-copy">确认删除「${esc(title)}」？删除后无法撤销，建议先导出备份。</p>`,'删除书页');if(!form)return;await api('/pages/'+id,{method:'DELETE'});state.page=null;state.dirty=false;await refresh();const first=state.pages.find(p=>!state.notebookId||p.notebookId===state.notebookId);if(first)await openPage(first.id);else showEmpty();toast('书页已删除');});});});
 $('save-status').onclick=runNavigation(async()=>{if(!state.error)return;if(state.error.status===401){const form=await dialog('登录已过期',textField('访问密码','password','','password','required autocomplete="current-password"'),'登录并保存');if(!form)return;await login(form.get('password'));await flush();toast('已重新登录并保存');}else if(state.error.status===409){const form=await dialog('检测到另一处修改','<div class="dialog-copy"><p>这个书页已在另一个窗口或设备中更新。可以把当前编辑内容保存为一个新书页，再比较两份内容。</p></div>','保留为新书页');if(!form)return;const current=state.page,html=serialize(),title=($('page-title').value+'（本机副本）').slice(0,160);const created=await api('/pages',{method:'POST',json:{notebookId:current.notebookId,title}});await api('/pages/'+created.id,{method:'PUT',json:{title,html,revision:created.revision}});state.dirty=false;state.error=null;await refresh();await openPage(created.id);toast('当前修改已保存为新书页');}else{await flush();toast('已重新保存');}},false);
 $('save-status').addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();$('save-status').click();}});
 document.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'&&!$('workspace').hidden){event.preventDefault();safeLeave().then(()=>toast('已保存')).catch(failure);}if(event.key==='/'&&!$('workspace').hidden&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)&&!document.activeElement.isContentEditable){event.preventDefault();$('workspace').classList.add('nav-open');$('search').focus();}});
 window.addEventListener('beforeunload',event=>{if(state.dirty||state.pending.size){event.preventDefault();event.returnValue='';}});
 window.addEventListener('online',()=>{if(state.dirty)flush().catch(()=>{});});
 async function start(){
  const local=['localhost','127.0.0.1','::1'].includes(location.hostname);
  if(!base&&location.hostname.endsWith('github.io')){$('connection-note').textContent='网站尚未连接笔记服务：请在 config.js 中填写云端服务地址。';$('login-submit').disabled=true;return;}
  if(local)$('connection-note').textContent='当前为本机版本。初始密码见项目 data 文件夹中的 local-password.txt；上线后可在其他设备访问云端笔记。';
   try{const status=await api('/status');if(!status.configured){$('login-error').textContent='笔记服务尚未设置密码，请先完成部署配置。';$('login-submit').disabled=true;return;}if(status.authenticated)await navigate(enterWorkspace);}
  catch(error){$('connection-note').textContent=error.message;}
 }
 start();
})();
