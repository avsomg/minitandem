export const TARGET_AGE = Object.freeze({min:0,max:6});
export const AGE_COHORTS = Object.freeze([
  {id:'infants',min:0,maxExclusive:1},
  {id:'toddlers',min:1,maxExclusive:3},
  {id:'preschool',min:3,maxExclusive:5},
  {id:'older-preschool',min:5,maxInclusive:6}
]);

export function ageCohort(age){
  if(!Number.isFinite(age))return null;
  return AGE_COHORTS.find(group=>age>=group.min&&
    (group.maxExclusive!==undefined?age<group.maxExclusive:age<=group.maxInclusive))?.id??null;
}

export function targetAgeFit(record){
  if(Number.isFinite(record.min)&&record.min>TARGET_AGE.max||Number.isFinite(record.max)&&record.max<TARGET_AGE.min)return 'outside';
  if(record.ageException||Number.isFinite(record.min))return 'confirmed';
  return 'possible';
}
