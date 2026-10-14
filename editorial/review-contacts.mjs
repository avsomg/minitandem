// Contacts of the public catalogue that no person has reviewed yet. The owner decided on 14 October 2026 that the catalogue lists
// organisation contacts only (docs/publication-scope.md); public-audit.mjs --strict fails while a contact is missing from
// public-contacts-reviewed.json.
//
//   node editorial/review-contacts.mjs            lists each unreviewed contact by card id and position, with its values.
//                                                 The values go to this terminal only, never into a file or a log.
//   node editorial/review-contacts.mjs --accept   adds the digests of the listed contacts to public-contacts-reviewed.json.
//
// Only the main chat or the owner runs --accept, and only after looking at every listed contact: an organisation's name, a landline
// and a role address (info@, secretariat@ ...) may be accepted. A mobile number, a private person's name or an e-mail address that
// carries a person's name is removed from the card instead, through the pipeline. Model workers never run --accept.
// --accept refuses while a listed contact holds a written-out Swiss mobile number.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CONTACT_RULE,hasSwissMobile} from './contact-rule.mjs';
import {REVIEWED_CONTACTS,contactRows,readReviewedContacts} from './public-audit.mjs';
import {loadCatalog} from './quality.mjs';

const workspace=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const zurichDate=()=>new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Zurich'});

export function pendingContacts(records,reviewed){
  const known=new Set(reviewed.digests);
  return contactRows(records).filter(row=>!known.has(row.digest)).map(row=>({...row,mobile:Object.values(row.contact).some(hasSwissMobile)}));
}
// Adds the digests of every pending contact. The list stays sorted and free of duplicates, so a change shows as added lines.
export function acceptContacts(records,reviewed,{date=zurichDate()}={}){
  const pending=pendingContacts(records,reviewed);
  const mobile=pending.filter(row=>row.mobile);
  if(mobile.length)throw Error('Not accepted: '+mobile.map(row=>`${row.card} ${row.position}`).join(', ')+' holds a Swiss mobile number. Remove such a contact from the card instead.');
  const digests=[...new Set([...reviewed.digests,...pending.map(row=>row.digest)])].sort();
  return {list:{reviewedOn:pending.length?date:reviewed.reviewedOn,rule:CONTACT_RULE,digests},accepted:pending.length};
}
export function writeReviewedContacts(list,file=path.join(workspace,REVIEWED_CONTACTS)){
  const temporary=file+'.tmp';
  fs.writeFileSync(temporary,JSON.stringify(list,null,2)+'\n');fs.renameSync(temporary,file);
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const records=loadCatalog().ACTIVITIES,reviewed=readReviewedContacts();
  const pending=pendingContacts(records,reviewed);
  if(process.argv.includes('--accept')){
    const {list,accepted}=acceptContacts(records,reviewed);
    if(accepted)writeReviewedContacts(list);
    console.log(accepted?`Accepted ${accepted} contact entries; ${REVIEWED_CONTACTS} now lists ${list.digests.length} distinct reviewed contacts.`:'Nothing to accept: every contact of the catalogue is reviewed.');
  }else if(!pending.length){
    console.log(`All ${contactRows(records).length} contacts of the catalogue are reviewed.`);
  }else{
    console.log(`${pending.length} contact(s) not yet reviewed. ${CONTACT_RULE}\n`);
    for(const row of pending){
      const {name,phone,email}=row.contact;
      console.log(`${row.card} ${row.position}${row.mobile?'  MOBILE NUMBER: remove from the card, do not accept':''}`);
      console.log(`  name:  ${name||''}\n  phone: ${phone||''}\n  email: ${email||''}`);
    }
    console.log('\nIf every contact above is an organisation contact, the main chat or the owner records them with: node editorial/review-contacts.mjs --accept');
  }
}
