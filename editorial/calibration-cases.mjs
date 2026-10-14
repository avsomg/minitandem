// These labels concern the frozen page and exact offer, not current availability.
const check=(field,value,expected,quote)=>({field,value,expected,quote});
export const controlCases=[
  {id:'sellenhof-wednesday',checks:[check('practical.booking',false,'approve','Teilnahme jederzeit ohne Anmeldung möglich!'),check('practical.commitment',true,'reject','CHF 45.-')]},
  {id:'sellenhof-group',checks:[check('practical.commitment',true,'approve','Anmeldung pro Quartal'),check('practical.groupSize',30,'reject','2-3 ReitschülerInnen')]},
  {id:'sellenhof-private',targetContext:{tariffUnit:'One regular individual lesson (Einzellektion), not the one-time trial (Probelektion).'},checks:[check('amount',80,'approve','Einzellektion'),check('amount',60,'reject','Einzellektion')]},
  {id:'pony-entdecken',checks:[check('parent','yes','approve','Eltern dürfen bleiben'),check('min',6,'reject','4-6 Jahre')]},
  {id:'pony-spass',checks:[check('min',6,'reject','6-9 Jahre'),check('age','Usually ages 6–9; a younger or older child can be discussed separately.','approve','6-9 Jahre')]},
  {id:'swim-marly',checks:[check('amount',250,'approve','CHF 250.-'),check('min',0.5,'reject','PE2')]},
  {id:'krabbel-plaffeien',checks:[check('practical.commitment',false,'approve','Das Treffen ist gratis'),check('max',4,'reject','bis circa 4 Jahren')]},
  {id:'krabbel-giffers',holdout:true,checks:[check('min',0,'approve','0 bis ca. 3 Jahren'),check('max',3,'reject','0 bis ca. 3 Jahren')]},
  {id:'elki-plaffeien',checks:[check('min',2.5,'approve','ab 2.5 Jahren'),check('days',[2],'reject','Montag, 17.00 - 18.00 Uhr')]},
  {id:'conservatoire',checks:[check('practical.duration',50,'approve','environ 50 minutes'),check('parent','no','reject','participation active de l’adulte')]},
  {id:'swim-courtepin-babies',holdout:true,checks:[check('practical.changing',true,'approve','Planches à langer'),check('amount',3240,'reject','CHF 324.00/trimestre')]},
  {id:'aef-estavayer-cafe',checks:[check('min',0,'approve','enfants de 0 à 7 ans'),check('amount',50,'reject','Famille : 50 CHF')]},
  {id:'aquarell',targetContext:{tariffUnit:'Child workshop fee, not the fee for an adult participant aged 16+.'},checks:[check('practical.groupSize',8,'approve','Maximale Teilnehmerzahl: 8 Personen'),check('amount',80,'reject','Kind')]},
  {id:'erntedank',checks:[check('events',[{date:'2026-10-04',start:'09:30',end:'10:30'}],'approve','4.10.26 - 9:30 - 10:30'),check('practical.booking',false,'reject','Erntedank-Familiengottesdienst')]},
  {id:'clubcafe-kerzers',holdout:true,checks:[check('practical.playArea',true,'approve','Spielplatz mit Sandkasten'),check('practical.standardGerman',true,'reject','Gartenwirtschaft')]},
  {id:'coop-fribourg-play',checks:[check('practical.changing',true,'approve','Table à langer'),check('practical.feeding',true,'approve','Allaitement bienvenu')]},
  {id:'migros-avry-play',holdout:true,checks:[check('days',[1,2,3,4,5,6],'approve','Dimanche'),check('practical.changing',true,'reject','Migros Restaurant')]},
  {id:'mpe',checks:[check('practical.booking',false,'approve','Sans rendez-vous'),check('max',4,'approve','enfants de 0 à 4 ans')]},
  {id:'suniai-family-yoga',checks:[check('practical.booking',true,'approve','Anmeldung'),check('practical.groupSize',1,'reject','Pro Bezugsperson max. 1 Kind.')]},
  {id:'kibim-murten',holdout:true,checks:[check('practical.indoor',true,'approve','in der Turnhalle'),check('practical.groupSize',6,'reject','Engagierte Eltern')]},
  {id:'familybloom-yoga',checks:[check('parent','yes','approve','In diesem Kurs teilen Eltern und Kinder'),check('languages',['DE'],'reject','Family Yoga (Eltern-Kind ab 2 Jahren)')]},
  {id:'elki-heitenried',checks:[check('practical.duration',60,'approve','09:00'),check('min',3,'reject','ab ca. 3 Jahren')]},
  {id:'ptites-bottes-family-visit',holdout:true,checks:[check('practical.duration',60,'approve','Durée : 1h00'),check('amount',50,'approve','Tarif : 50 CHF')]},
  {id:'museum',checks:[check('practical.commitment',false,'approve','Gratuit'),check('min',3,'reject','les plus petits et les plus grands sont les bienvenus!')]}
];
