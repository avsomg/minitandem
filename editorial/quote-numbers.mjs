// A number in a claim must be written in its quote. Code only, no model. A quote writes a figure when it has it in digits (decimal comma
// or point, Swiss thousands marks, ranges), as an English, German or French number word (0 to 20, the round tens, a half), or in one of a few
// stated conversions: months or weeks for an age in years, hours for a duration in minutes, the span between two times of day
// ("10:00 – 10:45"), "from birth" or "no minimum age" for age 0 and "free of charge" for an amount of 0. Any other figure is not one the page gave us.
// The same idea as numbers() and said() in KIE's jobs_direct.py, with the units this catalogue stores. It is deliberately generous:
// a figure the quote might write is accepted, so that only a figure it cannot write is refused.
export const NUMBER_FIELDS=new Set(['min','max','ageUpperUncertainFrom','amount','practical.groupSize','practical.duration']);
const AGE=new Set(['min','max','ageUpperUncertainFrom']);

// Number words without accents (the text is folded the same way, so a poster read by OCR still matches). "ein" and "un" are also articles:
// they count as 1, which can only make the rule more generous.
const WORDS={0:'zero null nul',1:'one eins ein eine einem einen einer eines un une',2:'two zwei zwo deux',3:'three drei trois',4:'four vier quatre',
  5:'five funf cinq',6:'six sechs',7:'seven sieben sept',8:'eight acht huit',9:'nine neun neuf',10:'ten zehn dix',11:'eleven elf onze',
  12:'twelve zwolf douze',13:'thirteen dreizehn treize',14:'fourteen vierzehn quatorze',15:'fifteen funfzehn quinze',16:'sixteen sechzehn seize',
  17:'seventeen siebzehn dix-sept',18:'eighteen achtzehn dix-huit',19:'nineteen neunzehn dix-neuf',20:'twenty zwanzig vingt',
  30:'thirty dreissig trente',40:'forty vierzig quarante',50:'fifty funfzig cinquante',60:'sixty sechzig soixante',70:'seventy siebzig',
  80:'eighty achtzig quatre-vingts quatre-vingt',90:'ninety neunzig',100:'hundred hundert cent'};
const VALUE=new Map(Object.entries(WORDS).flatMap(([n,list])=>list.split(' ').map(word=>[word,Number(n)])));
const WORD=[...VALUE.keys()].sort((a,b)=>b.length-a.length).map(word=>word.replace('-','[- ]')).join('|');
const HEAD=new RegExp(`^(?:${WORD})`);
// German joins a number to a unit ("zweijährig", "dreimal", "zweieinhalb"): such a compound starts with the number word.
const NUMBER_WORD=String.raw`(?<![\p{L}])(?:(?:${WORD})(?![\p{L}])|(?:${WORD})(?=jahr|monat|woch|mal|einhalb|stund|minut|tag))`;
const NUM=String.raw`(?:\d+(?:[.,]\d+)?|${NUMBER_WORD})`;
const TO=String.raw`(?:-|–|—|bis|a|au|to|et|und|and)`;
const valueOf=token=>/^\d/.test(token)?Number(token.replace(',','.')):VALUE.get(token.match(HEAD)[0].replace(/ /g,'-'));

// Lower case, no accents, no ß, one kind of apostrophe and space.
const fold=text=>String(text).normalize('NFD').replace(/\p{M}/gu,'').replace(/ß/g,'ss').toLowerCase().replace(/[’‘]/g,"'").replace(/[  ]/g,' ');

// Every figure the text writes for this field, as [value, tolerance]. A pattern that reads a figure removes it from the text, so
// that "10:45" is a time and not the numbers 10 and 45, and "2½" is 2.5 and not 2.
export function writtenNumbers(text,field){
  let rest=fold(text);const found=[];
  const add=(value,tolerance=1e-9)=>{if(Number.isFinite(value))found.push([value,tolerance]);};
  const read=(pattern,fn)=>{rest=rest.replace(new RegExp(pattern,'gu'),(...args)=>{fn(...args);return ' ';});};
  const age=AGE.has(field),duration=field==='practical.duration';

  // Zero is written without a digit as "from birth" or "no minimum age" for an age, and as "free of charge" for an amount.
  if(age)read(String.raw`\b(?:ab|von|seit|bei)\s+geburt\b|\bgeburt\b|\bfrom birth\b|\bnewborns?\b|\bneugeboren\w*|\bnouveau-?nes?\b|\bnouveaux-?nes\b|\bnaissance\b|\bkein(?:e|en)?\s+mindestalter\b|\bohne\s+mindestalter\b|\bkeine\s+alters(?:beschrankung|grenze)\b|\bno\s+(?:minimum|lower)\s+age\b|\bno\s+age\s+(?:limit|restriction)\b|\bpas\s+d'age\s+(?:minimum|minimal)\b|\bsans\s+limite\s+d'age\b|\btous\s+(?:les\s+)?ages\b|\bfor\s+all\s+ages\b|\balle\s+altersgruppen\b|\bjedes\s+alter\b`,()=>add(0));
  if(field==='amount')read(String.raw`\b(?:gratis|gratuit\w*|kostenlos\w*|kostenfrei\w*|gebuhrenfrei|unentgeltlich\w*|sans frais|offert\w*|free|(?:eintritt|zutritt|teilnahme|entree)\s+(?:ist\s+|est\s+)?(?:frei|libre))\b`,()=>add(0));

  // A span between two times of day is the length of a session. A time counts as one with a colon, an h or "Uhr" (a bare "9 bis 11" is not).
  if(duration){
    const clock=String.raw`(\d{1,2})(?:\s*[:h.]\s*(\d{2}))?(?:\s*(?:uhr|heures?|h)\b)?`;
    for(const [whole,h1,m1,h2,m2] of rest.matchAll(new RegExp(String.raw`${clock}\s*(?:-|–|—|bis|a|au|to|until|jusqu'a)\s*${clock}`,'gu'))){
      const start=h1*60+Number(m1||0),end=h2*60+Number(m2||0);
      if(/[:h]|uhr/.test(whole)&&h1<=24&&h2<=24&&Number(m1||0)<60&&Number(m2||0)<60&&end>start)add(end-start,0.5);
    }
  }
  // A half after a number: "2½", "2 Jahre und ein halbes Jahr", "deux ans et demi", "zweieinhalb", "anderthalb". A duration is in minutes.
  const half=(value)=>{add(value);if(duration)add(value*60,0.5);};
  read(String.raw`(\d+(?:[.,]\d+)?)\s*([½¼¾])`,(_,n,mark)=>half(valueOf(n)+(mark==='¼'?0.25:mark==='¾'?0.75:0.5)));
  read(String.raw`[½¼¾]`,mark=>half(mark==='¼'?0.25:mark==='¾'?0.75:0.5));
  read(String.raw`(${NUM})\s*(?:[a-z]{2,12}\.?\s*)?(?:und\s+(?:ein\w*\s+)?halb\w*|et\s+demi\w*|and\s+(?:a\s+|one\s+)?half)`,(_,n)=>half(valueOf(n)+0.5));
  read(String.raw`(${NUMBER_WORD})einhalb\w*`,(_,n)=>half(valueOf(n)+0.5));
  read(String.raw`\banderthalb\w*`,()=>half(1.5));
  read(String.raw`(\d+)\s*/\s*(\d+)\b`,(_,a,b)=>{add(Number(a));add(Number(b));if(Number(b)>0)add(Number(a)/Number(b));});

  // Hours and minutes: "1 Stunde 15", "1h30", "1,5 Stunden", "eine halbe Stunde".
  if(duration){
    const hour=String.raw`(?:stunden?|std|heures?|hours?|hrs?|uur|h)(?![\p{L}])\.?`;
    read(String.raw`\b(?:eine\s+)?halbe?\s+stunde\b|\bdemi-heure\b|\bhalf[- ]an[- ]hour\b|\bhalf[- ]hour\b`,()=>add(30,0.5));
    read(String.raw`\bdreiviertelstunde\b|\btrois quarts d'heure\b|\bthree quarters of an hour\b`,()=>add(45,0.5));
    read(String.raw`\bviertelstunde\b|\bquart d'heure\b|\bquarter of an hour\b|\bquarter hour\b`,()=>add(15,0.5));
    read(String.raw`(${NUM})\s*${hour}\s*(?:et|und|and)?\s*(\d{1,2})\b(?!\s*(?:uhr|h\b|:))`,(_,h,m)=>{
      if(Number(m)<60)add(valueOf(h)*60+Number(m),0.5);else{add(valueOf(h)*60,0.5);add(Number(m));}
    });
    read(String.raw`(${NUM})(?:\s*${TO}\s*(${NUM}))?\s*${hour}`,(_,a,b)=>{add(valueOf(a)*60,0.5);if(b)add(valueOf(b)*60,0.5);});
  }
  // Months and weeks for an age in years: "18 Monate", "6 bis 18 Monate", "2 Jahre und 6 Monate". The years themselves are plain figures.
  if(age){
    const month=String.raw`(?:monat\w*|mois\b|months?\b|mths?\b)`,week=String.raw`(?:woche\w*|semaine\w*|weeks?\b)`;
    read(String.raw`(${NUM})\s*(?:jahr\w*|ans?\b|years?\b|yrs?\b)\s*(?:,\s*)?(?:et|und|and)?\s*(${NUM})\s*${month}`,(_,y,m)=>add(valueOf(y)+valueOf(m)/12,0.005));
    for(const [unit,per,tolerance] of [[month,12,0.005],[week,52,0.01]])
      read(String.raw`(${NUM})(?:\s*${TO}\s*(${NUM}))?\s*${unit}`,(_,a,b)=>{add(valueOf(a)/per,tolerance);if(b)add(valueOf(b)/per,tolerance);});
  }

  // Times of day are not figures ("9h30", "10:45", "14 Uhr").
  read(String.raw`\b\d{1,2}\s*[:h]\s*\d{2}\b|\b\d{1,2}(?:\.\d{2})?\s*uhr\b|\b\d{1,2}\s*(?:h|heures?)\b(?!\s*\d)`,()=>{});
  // What remains: digits, grouped by a space, an apostrophe, a point or a comma (decimal comma or point), and number words.
  read(String.raw`\d+(?:[ '.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d+)?`,whole=>{
    add(Number(whole.replace(/[ ']/g,'').replace(',','.')));                      // 1,5  1.5  12.50
    if(!/[ '.,]/.test(whole)||/^\d+[.,]\d{1,2}$/.test(whole))return;
    const decimals=whole.match(/[.,](\d{1,2})$/)?.[1],integer=(decimals?whole.slice(0,-decimals.length-1):whole).replace(/[ '.,]/g,'');
    add(Number(integer+(decimals?'.'+decimals:'')));                              // 1'200.50  1.200,50  2 400
    if(!/ /.test(whole))return;
    for(const part of whole.split(' '))add(Number(part));                         // a table cell read as 2 400: the cells 2 and 400
  });
  read(NUMBER_WORD,word=>add(valueOf(word)));
  return found;
}

export const writesNumber=(field,value,quote)=>
  typeof value==='number'&&writtenNumbers(quote,field).some(([found,tolerance])=>Math.abs(found-value)<=tolerance);
// null when the quote writes the figure (or the field is not numeric); otherwise the reason, in the controller's voice.
export function numberProblem(field,value,quote){
  if(!NUMBER_FIELDS.has(field)||value===null||value===undefined)return null;
  return writesNumber(field,value,quote)?null:
    `${field} ${JSON.stringify(value)} is not written in its quote (digits, number words, a half, a stated unit conversion, a time span or a free-of-charge word)`;
}
