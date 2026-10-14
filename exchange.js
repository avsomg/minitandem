/* Explicit file exchange only. No network requests or private free-text fields.
   The format ids 'vmeste-plan' and 'vmeste-correction' are stored-file identifiers and stay as they are, so that files
   written earlier can still be read. Errors carry a code; the interface words them, the service logs the message. */
(() => {
  'use strict';
  const P=window.MinitandemPlanning,fail=P.fail;
  function plan(raw,allowed) {
    if(raw?.type!=='vmeste-plan'||raw.version!==1||!raw.visits||typeof raw.visits!=='object'||Array.isArray(raw.visits))throw fail('plan.notPlan','A Minitandem family plan file is required.');
    const entries=Object.entries(raw.visits);
    if(!entries.length||entries.length>P.maxVisits)throw fail('plan.count','A plan must contain between 1 and 200 visits.');
    const visits={};
    for(const [id,v] of entries){
      if(!/^v-[a-z0-9-]{1,60}$/.test(id)||!v||!allowed.has(v.activity)||!P.validDate(v.date)||(v.time&&!P.validTime(v.time))||!P.bookingStateKeys.includes(v.booking))throw fail('plan.invalidVisit','The file contains an unknown place or an invalid visit. Import cancelled.');
      visits[id]={activity:v.activity,date:v.date,time:v.time||'',booking:v.booking};
    }
    return {type:'vmeste-plan',version:1,visits};
  }
  function planSummary(raw,allowed,current) {
    const clean=plan(raw,allowed),entries=Object.entries(clean.visits);
    if(new Set([...Object.keys(current),...entries.map(([id])=>id)]).size>P.maxVisits)throw fail('plan.tooMany','More than 200 visits after merging.');
    for(const [id,v] of entries)if(current[id]&&current[id].activity!==v.activity)throw fail('plan.otherPlace','A visit id belongs to a different place. Import cancelled.');
    return {clean,added:entries.filter(([id])=>!current[id]).length,changed:entries.filter(([id,v])=>current[id]&&['date','time','booking'].some(k=>current[id][k]!==v[k])).length};
  }
  // Stored values of the correction topic. The interface words them through the dictionaries.
  const topics=['Schedule','Price','Age or adult participation','Address or closure','Other'];
  function report(raw,allowed) {
    if(raw?.type!=='vmeste-correction'||raw.version!==1||!allowed.has(raw.activity)||!topics.includes(raw.topic)||!P.validDate(raw.date)||typeof raw.message!=='string'||!raw.message.trim()||raw.message.length>2000)throw fail('report.invalid','Invalid correction.');
    let source='';
    if(raw.source){
      let url;
      try{url=new URL(raw.source);}catch{throw fail('report.source','The source must be an HTTPS link without a password.');}
      if(url.protocol!=='https:'||url.username||url.password||url.href.length>500)throw fail('report.source','The source must be an HTTPS link without a password.');
      source=url.href;
    }
    return {type:'vmeste-correction',version:1,activity:raw.activity,topic:raw.topic,message:raw.message.trim(),source,date:raw.date};
  }
  function metrics(visits) {
    const values=Object.values(visits),went=values.filter(v=>v.attendance==='went');
    // Totals have no dates, place IDs, notes, family identifiers or inferred visits.
    return {type:'minitandem-pilot-summary',version:1,planned:values.length,attended:went.length,missed:values.filter(v=>v.attendance==='missed').length,
      selectedHere:went.filter(v=>v.usefulness==='yes').length,knownBefore:went.filter(v=>v.usefulness==='no').length,
      enoughInformation:went.filter(v=>v.information==='enough').length,neededClarification:went.filter(v=>v.information==='missing').length,
      wantRepeat:went.filter(v=>v.outcome==='repeat').length};
  }
  window.MinitandemExchange={plan,planSummary,report,topics,metrics};
})();
