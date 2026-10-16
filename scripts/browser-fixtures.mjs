// Invented cards added only to a browser response, after the committed public data layers.
export const regressionFixtures=';('+function(){
  const base=window.ACTIVITIES.find(a=>a.id==='mpe');
  const make=(id,name,extra={})=>{
    const card={...structuredClone(base),id,name,age:'2–4',min:2,max:4,events:[],notes:[],...extra};
    delete card.ageException;delete card.ageUpperUncertainFrom;
    return card;
  };
  for(const [key,value] of [['absent',undefined],['undefined',undefined],['null',null],['zero',0],['positive',4]]){
    const card=make('browser-age-'+key,'Browser age '+key);
    if(key!=='absent')card.ageUpperUncertainFrom=value;
    window.ACTIVITIES.push(card);
  }
  window.ACTIVITIES.push(
    make('browser-date-monthly','Browser date monthly',{days:[2],schedule:'1st and 3rd Tue 10:00–11:00'}),
    make('browser-date-weekly','Browser date weekly',{days:[2],schedule:'Tue 10:00–11:00'}),
    make('browser-date-event','Browser date event',{days:[2],schedule:'Tue 20.10.2026 10:00–11:00',events:[{date:'2026-10-20',start:'10:00',end:'11:00'}]})
  );
}.toString()+')();';
