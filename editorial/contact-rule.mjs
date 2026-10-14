// The owner's decision of 14 October 2026 (docs/publication-scope.md): the public catalogue lists organisation contacts only.
// This is the one place for the pattern of a written-out Swiss mobile number. The field contract (worker claims and editor patches)
// and the strict publication audit both use it. It also defines the digest under which a contact a person has reviewed is recorded
// in public-contacts-reviewed.json.
import {createHash} from 'node:crypto';

export const CONTACT_RULE='Public catalogue contacts are organisation contacts only: the organisation\'s name, landline and role address (info@, secretariat@ ...). '+
  'Never a mobile number, a private person\'s name or an e-mail address that carries a person\'s name; such a contact is left out and the source link leads families to it.';

// 07[5-9] in national form, or +41 / 0041 (optionally followed by (0)) and 7[5-9], then the usual seven digits.
// Digits may be grouped by a space, a no-break space, a dot, a hyphen or a slash, or not at all.
// The number must not continue a word, a longer run of digits or a decimal number, and must not be followed by a digit or letter.
const SEPARATOR='[ \\u00a0\\u202f./-]?';
const MOBILE=new RegExp(`(?<![\\w+]|\\d[.,])(?:(?:\\+|00)41${SEPARATOR}(?:\\(0\\)${SEPARATOR})?|0)7[5-9](?:${SEPARATOR}\\d){7}(?!\\w)`,'gu');
// Digits inside a web address are not a phone number (tel: and mailto: are not web addresses and stay in).
const WEB_ADDRESS=/\b(?:https?:\/\/|www\.)[^\s"'<>()[\]{}\\|^`]+/giu;
// A no-break space written as an escape or an HTML entity separates digit groups as well.
const ESCAPED_SPACE=/\\u00a0|\\u202f|&nbsp;|&#160;|&#xa0;|&#8239;|&#x202f;/giu;

// How many written-out Swiss mobile numbers a text holds. Callers report the count and where, never the number.
export function swissMobileCount(text){
  if(typeof text!=='string')return 0;
  return (text.replace(ESCAPED_SPACE,' ').replace(WEB_ADDRESS,' ').match(MOBILE)||[]).length;
}
export const hasSwissMobile=text=>swissMobileCount(text)>0;

// The digest of one contact as a person reviewed it: sha256 of JSON.stringify({name,phone,email}), a missing field counted as ''.
export function contactDigest(contact){
  const {name,phone,email}=contact||{};
  return createHash('sha256').update(JSON.stringify({name:name??'',phone:phone??'',email:email??''})).digest('hex');
}
