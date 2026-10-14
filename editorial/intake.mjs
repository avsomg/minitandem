import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {loadCatalog,root} from './quality.mjs';

const input=process.argv[2];
if(!input)throw Error('Usage: node editorial/intake.mjs <correction.json>');
if(fs.statSync(input).size>20000)throw Error('Correction is too large');
const catalog=loadCatalog(),allowed=new Map(catalog.ACTIVITIES.map(a=>[a.id,a]));
const report=catalog.MinitandemExchange.report(JSON.parse(fs.readFileSync(input,'utf8')),allowed);
const id=crypto.createHash('sha256').update(JSON.stringify(report)).digest('hex').slice(0,20);
const directory=process.env.MINITANDEM_CORRECTION_DIR||path.join(root,'editorial/corrections');fs.mkdirSync(directory,{recursive:true});
const file=path.join(directory,id+'.json');
const duplicate=fs.existsSync(file);
if(!duplicate)fs.writeFileSync(file,JSON.stringify({id,status:'pending-review',assignedTo:null,importedAt:new Date().toISOString(),report},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({file,duplicate,status:'pending-review',catalogChanged:false},null,2));
