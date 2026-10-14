// Scans the files git would publish (tracked plus not ignored) for things that must not leave the owner's machine:
// secrets and tokens, absolute paths of a personal computer, account identifiers, Cyrillic text, and contact data outside the catalogue.
// Usage: node scripts/scan-public.mjs [directory]   Exit code 1 when there is a finding outside the catalogue files.
// E-mail addresses and phone numbers of organisers are the product (the catalogue lists the contacts organisers publish themselves);
// they are counted for the catalogue files and are a finding anywhere else.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const RULES=[
  ['private-key',/-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['api-token',/\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[abpr]-[A-Za-z0-9-]{10,}|vercel_[A-Za-z0-9_]{20,})/],
  ['bearer-token',/\bBearer\s+[A-Za-z0-9._~+/-]{24,}/],
  ['jwt',/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['vercel-identifier',/\b(?:prj|team)_[A-Za-z0-9]{20,}\b/],
  ['personal-computer-path',/(?<![A-Za-z0-9._~%-])(?:\/Users\/[A-Za-z0-9._-]+|\/private\/(?:tmp|var)\/(?!folders\/x\/)[A-Za-z0-9]|\/home\/[a-z][a-z0-9_-]+\/)|[A-Z]:\\Users\\/],
  ['cyrillic',/[\u0400-\u04FF]/]
];
const EMAIL=/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE=/(?:\+41|\b0)[ ]?[0-9]{2}[ ]?[0-9]{3}[ ]?[0-9]{2}[ ]?[0-9]{2}\b/g;
// Placeholders and documentation addresses are not contact data; neither is the project's own public address.
const HARMLESS_PHONE=/(?:000 00 00|123 45 67|00 00 00)$/;
const HARMLESS_EMAIL=/@(?:[a-z0-9-]+\.)*(?:example\.(?:org|com|ch)|localhost)\b|^(?:a"b|owner|user|you|name)@|^hello@minitandem\.ch$/i;
export const CATALOGUE_FILES=new Set(['data.js','research.md','data-reviewed.js','design/minitandem-mockup.html']);
const SKIP_BINARY=/\.(?:png|jpe?g|gif|webp|ico|woff2?|pdf|sqlite)$/i;
// Third-party bundles contain long digit runs and the like; they are checked for secrets and paths only.
const VENDOR=/^assets\/(?:leaflet|lucide)[\w.-]*\.js$/;

export function filesToScan(root){
  try{
    return execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8',maxBuffer:64_000_000})
      .split('\0').filter(Boolean).filter(file=>fs.existsSync(path.join(root,file)));
  }catch{
    // Without git (a copy of the tracked files, for example): walk the folder and honour the plain names and paths of .gitignore.
    const lines=fs.existsSync(path.join(root,'.gitignore'))?fs.readFileSync(path.join(root,'.gitignore'),'utf8').split('\n').map(line=>line.trim()).filter(line=>line&&!line.startsWith('#')):[];
    const skip=rel=>lines.some(line=>{const pattern=line.replace(/\/$/,'');return pattern.includes('/')?rel===pattern||rel.startsWith(pattern+'/'):rel.split('/').includes(pattern);});
    const files=[];
    const walk=folder=>{for(const entry of fs.readdirSync(folder,{withFileTypes:true})){
      const full=path.join(folder,entry.name),rel=path.relative(root,full).split(path.sep).join('/');
      if(entry.name==='.git'||skip(rel))continue;
      if(entry.isDirectory())walk(full);else files.push(rel);
    }};
    walk(root);return files;
  }
}

export function scan(root){
  const findings=[],catalogue={files:{},emails:0,phones:0};
  const files=filesToScan(root);
  for(const file of files){
    if(SKIP_BINARY.test(file))continue;
    const text=fs.readFileSync(path.join(root,file),'utf8');
    const lines=text.split('\n');
    const rules=VENDOR.test(file)?RULES.filter(([name])=>!['cyrillic'].includes(name)):RULES;
    lines.forEach((line,index)=>{
      for(const [name,pattern] of rules)if(pattern.test(line))findings.push({file,line:index+1,rule:name});
    });
    if(VENDOR.test(file))continue;
    const emails=(text.match(EMAIL)||[]).filter(address=>!HARMLESS_EMAIL.test(address));
    const phones=text.match(PHONE)||[];
    if(CATALOGUE_FILES.has(file)){
      catalogue.files[file]={emails:emails.length,phones:phones.length};catalogue.emails+=emails.length;catalogue.phones+=phones.length;
    }else{
      lines.forEach((line,index)=>{
        if((line.match(EMAIL)||[]).some(address=>!HARMLESS_EMAIL.test(address)))findings.push({file,line:index+1,rule:'email-outside-catalogue'});
        if((line.match(PHONE)||[]).some(number=>!HARMLESS_PHONE.test(number)))findings.push({file,line:index+1,rule:'phone-outside-catalogue'});
      });
    }
  }
  return {scanned:files.length,findings,catalogue};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=path.resolve(process.argv[2]||path.join(path.dirname(fileURLToPath(import.meta.url)),'..'));
  const report=scan(root);
  console.log(JSON.stringify(report,null,2));
  process.exit(report.findings.length?1:0);
}
