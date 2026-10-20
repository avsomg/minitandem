import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {serviceError} from './server.mjs';
const read=file=>fs.readFileSync(new URL(file,import.meta.url),'utf8');
test('Caddy masks both IP fields and deletes credentials and untrusted request text before file output',()=>{
  const config=read('docker/Caddyfile');
  for(const field of ['remote_ip','client_ip']) assert.match(config,new RegExp(`request>${field} ip_mask \\{\\s*ipv4 24\\s*ipv6 48\\s*\\}`));
  for(const field of ['request>headers>Authorization','request>headers>Cookie','request>headers','request>uri','request>host','resp_headers']) assert.ok(config.includes(field+' delete'));
  assert.match(config,/format filter\s*\{\s*wrap json/);
  assert.match(config,/output file \/var\/log\/caddy\/access.json\s*\{\s*roll_disabled/);
  assert.doesNotMatch(config,/output stdout|log_credentials/);
});
test('Caddy\'s own error and proxy records keep no visitor address or request text, and access records stay out of them',()=>{
  const config=read('docker/Caddyfile'),global=config.slice(0,config.indexOf('\nwww.minitandem.ch'));
  const block=global.match(/log default \{([\s\S]*?)\n\t\}/);assert.ok(block,'the default logger is configured');
  assert.match(block[1],/exclude http\.log\.access/);
  for(const field of ['request>remote_ip','request>client_ip','request>remote_port','request>headers','request>uri','request>host'])assert.ok(block[1].includes(field+' delete'),field);
});
test('access log lifetime is bounded below seven days by process time and volatile storage, not file size or traffic',()=>{
  const script=read('docker/access-log-entrypoint.sh'),compose=read('compose.yaml');
  const timeout=script.match(/exec timeout -s TERM -k (\d+) (\d+) "\$@"/);
  assert.ok(timeout);assert.ok(Number(timeout[1])+Number(timeout[2])<7*24*60*60);
  assert.match(script,/: > \/var\/log\/caddy\/access.json/);
  const caddy=compose.slice(compose.indexOf('\n  caddy:'));
  assert.match(caddy,/restart: unless-stopped/);
  assert.match(caddy,/tmpfs:\s*\n\s+- \/var\/log\/caddy:size=32m,mode=0700/);
  assert.match(caddy,/entrypoint: \["\/bin\/sh", "\/etc\/caddy\/access-log-entrypoint.sh"\]/);
  assert.match(caddy,/command: \["caddy", "run"/);
  // The script is in the Caddy image of the release (not mounted from the checkout, where a running container would keep an older copy).
  assert.match(read('Dockerfile'),/^COPY docker\/Caddyfile docker\/site\.caddy docker\/preview\.Caddyfile docker\/access-log-entrypoint\.sh \/etc\/caddy\/$/m);
  assert.doesNotMatch(caddy,/access-log-entrypoint\.sh:/);
});
test('service error logging cannot include an IP from an exception or nested request',()=>{
  const before=console.error,lines=[];console.error=(...args)=>lines.push(args.join(' '));
  try{
    serviceError(Object.assign(Error('failed for 192.0.2.123 and 2001:db8::1'),{code:'EACCES',request:{ip:'192.0.2.123'}}));
    serviceError({code:'192.0.2.123',message:'private',stack:'private'});
  }finally{console.error=before;}
  assert.deepEqual(lines,['Service error EACCES','Service error INTERNAL']);
});
