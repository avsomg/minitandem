import fs from 'node:fs';
import Ajv from 'ajv';
import {CLAIM_FIELDS,FIELD_CONTRACT} from './field-contract.mjs';
import {PROJECT_ID} from './project-id.mjs';

const object=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
const literal=value=>({type:'string',enum:[value]});
const nonempty={type:'string',pattern:'\\S'};
const enums={status:['active','check','future','closed','excluded'],parent:['yes','no','unknown'],
  addressPrecision:['exact','area'],priceKind:['unknown','free','donation','visit','course','year']};
const date={type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$'};
const clock={type:'string',pattern:'^(?:|(?:[01]\\d|2[0-3]):[0-5]\\d)$'};
const contact=object({name:{type:'string'},phone:{type:'string'},email:{type:'string'}});
const event=object({date,start:clock,end:clock,title:{type:'string'},address:{type:'string'}});

export function claimValueSchema(field){
  const rule=FIELD_CONTRACT[field];
  if(!CLAIM_FIELDS.has(field))throw Error('Unknown worker claim field: '+field);
  if(rule.type==='enum')return {type:'string',enum:enums[field]};
  if(rule.type==='date')return date;
  if(rule.type==='boolean')return {type:'boolean'};
  if(rule.type==='number')return field==='practical.groupSize'?{type:'integer',minimum:1}:
    field==='practical.duration'?{type:'number',exclusiveMinimum:0}:{type:'number',minimum:0};
  if(rule.type==='string')return nonempty;
  if(rule.type==='contact[]')return {type:'array',items:contact};
  if(rule.type==='event[]')return {type:'array',items:event};
  if(rule.type==='integer[]')return {type:'array',items:{type:'integer',minimum:1,maximum:7}};
  if(rule.type==='string[]')return {type:'array',items:field==='languages'?{type:'string',enum:['DE','FR','DE/FR','EN','none']}:nonempty};
  throw Error('No native worker schema for '+field);
}
const common={key:nonempty,scope:{type:'string',enum:['exact-card','venue-only','uncertain']},
  kind:{type:'string',enum:['official','visitor','historical','inference']},source:{type:'string'},
  quote:{type:'string'},snapshotId:{type:'null'},note:nonempty};

export function workerOutputSchema(job){
  if(job.kind!=='facts'){
    const schema=JSON.parse(fs.readFileSync(new URL('./agent-output.schema.json',import.meta.url),'utf8'));
    schema.properties.jobId=literal(job.id);schema.properties.inputRevision=literal(job.input_revision);return schema;
  }
  const unknown=object({...common,field:{type:'string',enum:[...CLAIM_FIELDS]},value:{type:'null'},
    status:{type:'string',enum:['unknown','conflicting']}});
  const claims=[unknown,...[...CLAIM_FIELDS].map(field=>object({...common,field:literal(field),value:claimValueSchema(field),status:literal('supported')}))];
  const bundle=object({project:literal(PROJECT_ID),cardId:literal(job.card_id||job.payload.card.id),
    snapshots:{type:'array',items:{type:'null'},maxItems:0},claims:{type:'array',items:{anyOf:claims},maxItems:100}});
  return object({project:literal(PROJECT_ID),jobId:literal(job.id),inputRevision:literal(job.input_revision),result:object({bundle})});
}

export function decodeWorkerOutput(envelope,job){
  const validate=new Ajv({strict:true,allErrors:false}).compile(workerOutputSchema(job));
  if(!validate(envelope))throw Error('Worker output schema mismatch: '+JSON.stringify(validate.errors).slice(0,350));
  return job.kind==='facts'?envelope.result:JSON.parse(envelope.resultJson);
}
