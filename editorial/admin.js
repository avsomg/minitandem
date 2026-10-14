(() => {
  'use strict';
  const $=selector=>document.querySelector(selector);
  let key=sessionStorage.getItem('minitandem-editor-key')||'';
  if(key)$('#key').value=key;
  const item=(tag,text,cls='')=>{const node=document.createElement(tag);node.textContent=text;if(cls)node.className=cls;return node;};
  let loading=false,session=0;
  const number=value=>new Intl.NumberFormat('en-CH').format(value||0);
  const kinds={facts:'Initial facts',search:'External search',verify:'Evidence verification','verify-facts':'Fact verification',integrate:'Editing',editorial:'Corrections','review-patch':'Patch review',adjudicate:'Dispute arbitration','adjudicate-facts':'Disputed facts',qa:'Tests',release:'Release'};
  const states={ready:'Queued',leased:'In progress',retry:'Retry later',done:'Done','await-source':'Needs a source',attention:'Needs a decision',superseded:'Superseded'};
  function metrics(container,rows){
    container.replaceChildren();for(const [value,label] of rows){const node=item('div',label);node.prepend(item('strong',number(value)));container.append(node);}
  }
  function operations(data){
    metrics($('#operations-summary'),[[data.updatedCards,'cards updated'],[data.fullyReviewedCards,'fully reviewed'],[data.active.length,'in progress now']]);
    const message=$('#operations-message');message.className=data.circuit?.open?'warning':'muted';
    message.textContent=data.circuit?.open?'Runs stopped: '+data.circuit.reason:'Queue status as of '+new Date(data.generatedAt).toLocaleString('en-CH');
    const jobs=$('#job-counts');jobs.replaceChildren();
    const list=document.createElement('dl');list.className='job-list';
    for(const row of data.counts.filter(r=>!['done','superseded'].includes(r.state))){list.append(item('dt',`${kinds[row.kind]||row.kind} · ${states[row.state]||row.state}`),item('dd',number(row.count)));}
    if(list.children.length)jobs.append(list);else jobs.append(item('p','The queue is empty.','muted'));
    const usage=$('#usage');usage.replaceChildren();usage.append(item('p','Only CLI runs are counted. Chat and scheduled-run costs are not included; this is not a provider invoice.','muted'));
    for(const row of data.usage){const article=item('article','');article.append(item('h3',row.route),item('p',`${number(row.runs)} runs · input: ${number(row.inputTokens)} tokens · cached: ${number(row.cachedInputTokens)} · output: ${number(row.outputTokens)} · tool calls: ${number(row.toolCalls)}`));usage.append(article);}
    for(const row of data.stageTimes)usage.append(item('p',`${kinds[row.kind]||row.kind}: median ${number(row.medianSeconds)} s · completed attempts: ${number(row.completedAttempts)}`,'muted'));
    const blocked=$('#blocked');blocked.replaceChildren();$('#blocked-count').textContent='('+number(data.blocked.length)+')';
    if(!data.blocked.length)blocked.append(item('p','No jobs are waiting for a decision.','muted'));
    for(const row of data.blocked){const article=item('article','');article.append(item('h3',row.cardId),item('p',`${kinds[row.kind]||row.kind} · ${states[row.state]||row.state} · attempt ${row.attempt}`),item('p',row.error||'Not enough confirming evidence from a source yet.','muted'));blocked.append(article);}
  }
  async function api(path,method='GET',payload){
    const requestSession=session;
    try{
      const response=await fetch(path,{method,headers:{Authorization:'Bearer '+key,...(payload?{'Content-Type':'application/json'}:{})},body:payload?JSON.stringify(payload):undefined,cache:'no-store',signal:AbortSignal.timeout(15000)});
      const data=await response.json();
      if(requestSession!==session)throw new DOMException('Session changed','AbortError');
      if(!response.ok)throw Error(data.error||'Server error');
      return data;
    }catch(error){if(requestSession!==session)throw new DOMException('Session changed','AbortError');throw error;}
  }
  async function load(){
    if(loading)return;loading=true;$('#refresh').disabled=true;$('#access button').disabled=true;
    const requestSession=session;
    $('#message').textContent='Loading the queue…';
    try{
      const data=await api('/api/v1/admin/queue');
      sessionStorage.setItem('minitandem-editor-key',key);
      $('#dashboard').hidden=false;$('#access').hidden=true;$('#message').textContent='';$('#updated').textContent='Updated '+new Date().toLocaleTimeString('en-CH');
      const summary=$('#summary');summary.replaceChildren();
      for(const [number,label] of [[data.quality.records,'active cards'],[data.quality.stale,'with an overdue review date'],[data.quality.withoutMonitor,'without source monitoring'],[data.corrections.filter(c=>c.status==='pending-review').length,'new corrections']]){
        const node=item('div',label);node.prepend(item('strong',String(number)));summary.append(node);
      }
      const corrections=$('#corrections');corrections.replaceChildren();
      if(!data.corrections.length)corrections.append(item('p','No corrections yet.','muted'));
      for(const c of data.corrections){
        const article=document.createElement('article');
        article.append(item('h3',`${c.report.activity} · ${c.report.topic}`),item('p',c.report.message),item('p',`Status: ${c.status} · received ${new Date(c.importedAt).toLocaleString('en-CH')}`,'muted'));
        if(c.report.source){const a=item('a','Source');a.href=c.report.source;a.target='_blank';a.rel='noopener noreferrer';article.append(a);}
        if(c.status==='pending-review'){
          const actions=item('div','','actions');
          for(const [status,label] of [['ready-to-apply','Checked, apply to the catalogue'],['rejected','Reject']]){
            const button=item('button',label,status==='rejected'?'secondary':'');
            button.type='button';button.addEventListener('click',async()=>{try{await api('/api/v1/admin/corrections/'+c.id,'POST',{status});await load();}catch(error){if(error.name!=='AbortError')$('#message').textContent=error.message;}});actions.append(button);
          }
          article.append(actions);
        }
        corrections.append(article);
      }
      const quality=$('#quality');quality.replaceChildren();
      for(const row of data.quality.queue){
        const article=document.createElement('article');article.append(item('h3',row.name),item('p',`${row.region} · ${row.stale?'Review date has passed · ':''}${row.watched.length?'Monitor: '+row.watched.join(', '):'Source without monitoring'}`,'muted'),item('p',`To clarify: ${[...row.critical,...row.missing].join(', ')||'none'}`,'muted'));
        if(row.source){const a=item('a','Open source');a.href=row.source;a.target='_blank';a.rel='noopener noreferrer';article.append(a);}
        quality.append(article);
      }
      try{operations(await api('/api/v1/admin/operations'));}catch(error){if(error.name!=='AbortError'){$('#operations-summary').replaceChildren();$('#job-counts').replaceChildren();$('#usage').replaceChildren();$('#blocked').replaceChildren();$('#blocked-count').textContent='';$('#operations-message').textContent=error.message;}}
    }catch(error){if(error.name!=='AbortError'){$('#dashboard').hidden=true;$('#access').hidden=false;$('#message').textContent=error.message;}}
    finally{if(requestSession===session){loading=false;$('#refresh').disabled=false;$('#access button').disabled=false;}}
  }
  $('#access').addEventListener('submit',event=>{event.preventDefault();key=$('#key').value.trim();load();});
  $('#refresh').addEventListener('click',()=>load());
  $('#logout').addEventListener('click',()=>{session++;loading=false;$('#refresh').disabled=false;$('#access button').disabled=false;sessionStorage.removeItem('minitandem-editor-key');key='';$('#key').value='';$('#dashboard').hidden=true;$('#access').hidden=false;$('#message').textContent='';$('#key').focus();});
  window.lucide?.createIcons();
  if(key)load();
})();
