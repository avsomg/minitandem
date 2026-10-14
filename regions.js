/* District classification is independent of the original routes from Plaffeien. */
(() => {
  const regions = {
    sense:'Sense / Singine', sarine:'Sarine / Saane', see:'See / Lac',
    gruyere:'Gruyère / Greyerz', glane:'Glâne', broye:'Broye', veveyse:'Veveyse',
    outside:'Outside the canton', unknown:'District to be confirmed'
  };
  const towns = {
    sense:['Plaffeien','Oberschrot','Tentlingen','Düdingen','Giffers','St. Ursen','Tafers','Rechthalten','Alterswil','Weissenstein','Giffers / Tentlingen','Schwarzsee','Brünisried','Sense','St. Antoni','Heitenried'],
    sarine:['Fribourg','Marly','Fribourg / Granges-Paccot','Bonnefontaine','Granges-Paccot','Villars-sur-Glâne'],
    see:['Murten','Meyriez','Kerzers'], outside:['Oleyres']
  };
  const lookup = new Map(Object.entries(towns).flatMap(([region,names]) => names.map(name => [name,region])));
  for (const a of window.ACTIVITIES) {
    a.region ||= lookup.get(a.town) || 'unknown';
    // Editorial review target, never an organiser's promise of validity.
    if (!a.reviewAfter) {
      const date = new Date(a.checked+'T12:00:00Z');
      date.setUTCDate(date.getUTCDate() + (a.status==='active'?90:30));
      a.reviewAfter = date.toISOString().slice(0,10);
    }
  }
  window.CATALOG_REGIONS = regions;
  window.CATALOG_COVERAGE = {sense:'partial', sarine:'partial', see:'pilot', gruyere:'pilot', glane:'pilot', broye:'pilot', veveyse:'pilot'};
  // Reviewed updates apply after all legacy layers and derived defaults.
  window.STALE_UPDATES=[];
  for(const {jobId,draft,baseRecord,research} of window.APPROVED_UPDATES||[]){
    const a=window.ACTIVITIES.find(card=>card.id===draft.cardId);
    if(!a)throw Error('Unknown approved update: '+draft.cardId);
    const withoutGeo=card=>{const {geo,...base}=card;return base;};
    if(JSON.stringify(withoutGeo(a))!==JSON.stringify(withoutGeo(baseRecord))){
      window.STALE_UPDATES.push({id:draft.cardId,jobId});continue;
    }
    Object.assign(a,draft.patch);
    a.practical={...a.practical,...draft.practicalPatch};
    if(draft.warnings)a.practical.warnings=draft.warnings;
    a.research=research;
    for(const finding of draft.findings)if(!a.sources.some(s=>s.url===finding.url))
      a.sources.push({url:finding.url,label:'Additional check: '+finding.field});
  }
  delete window.APPROVED_UPDATES;
})();
