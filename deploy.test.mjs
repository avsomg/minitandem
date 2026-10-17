import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const root=path.dirname(fileURLToPath(import.meta.url));
const script=path.join(root,'ops','deploy.sh');
const HAS_TOOLS=['bash','git'].every(tool=>spawnSync(tool,['--version'],{stdio:'ignore'}).status===0);

// ops/deploy.sh runs with test doubles for ssh, docker, gh and curl on PATH. The fake ssh runs the "remote" command here, in a
// clone of a local repository that stands in for /opt/minitandem; the fake docker and curl keep their state in plain files.
const TOOLS={
  ssh:`#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in -i|-o) shift 2;; -*) shift;; *) break;; esac; done
host=$1; shift
echo "ssh $host" >> "$FAKE/log"
exec sh -c "$1"
`,
  gh:`#!/bin/sh
echo "gh $*" >> "$FAKE/log"
cat "$FAKE/gh.json"
`,
  curl:`#!/bin/sh
for last; do :; done
case "$last" in
  http://127.0.0.1:*) [ -f "$FAKE/preview-up" ] || exit 7; cat "$FAKE/preview.json" ;;
  */healthz)
    if [ -f "$FAKE/steal-owner" ] && [ -d "$DEPLOY_DIR/.deploy-lock" ]; then
      current=$(sed -n 's/^MINITANDEM_TAG=//p' "$DEPLOY_DIR/.env")
      if [ "$current" != "$(cat "$FAKE/old-tag")" ]; then echo replacement > "$DEPLOY_DIR/.deploy-lock/id"; exit 22; fi
    fi
    f="$FAKE/public-$(cat "$FAKE/running").json"; [ -f "$f" ] || exit 22; cat "$f" ;;
  *) exit 6 ;;
esac
`,
  docker:`#!/bin/sh
echo "docker $*" >> "$FAKE/log"
case "$1 $2" in
  "compose build")
    if [ -f "$FAKE/wait-build" ]; then touch "$FAKE/build-entered"; while [ ! -f "$FAKE/release-build" ]; do sleep 0.02; done; fi
    [ -f "$FAKE/build-fails" ] && { echo "build failed" >&2; exit 1; }
    echo "$MINITANDEM_TAG" >> "$FAKE/images" ;;
  "compose up")
    tag=$(sed -n 's/^MINITANDEM_TAG=//p' .env)
    case "$*" in *--no-build*) grep -qx "$tag" "$FAKE/images" || { echo "image missing" >&2; exit 1; } ;; esac
    echo "$tag" > "$FAKE/running"; echo "up $tag" >> "$FAKE/log" ;;
  "compose ps") echo app-container ;;
  "compose run") [ -f "$FAKE/caddy-invalid" ] && { echo "invalid Caddyfile" >&2; exit 1; }; echo "Valid configuration" ;;
  "image inspect") grep -qx "$(echo "$3" | sed 's/^minitandem-app://')" "$FAKE/images" ;;
  "rm -f") rm -f "$FAKE/preview-up" ;;
  "run -d") touch "$FAKE/preview-up"; echo container-id ;;
  "inspect --format") if [ -f "$FAKE/unhealthy-$(cat "$FAKE/running")" ]; then echo unhealthy; else echo healthy; fi ;;
  "logs --tail") echo "fake preview log" ;;
  *) echo "fake docker: unexpected call: $*" >&2; exit 99 ;;
esac
`
};
const git=(cwd,...args)=>{
  const result=spawnSync('git',['-c','commit.gpgsign=false',...args],{cwd,encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'t',GIT_AUTHOR_EMAIL:'t@example.org',GIT_COMMITTER_NAME:'t',GIT_COMMITTER_EMAIL:'t@example.org'}});
  assert.equal(result.status,0,result.stderr);return result.stdout.trim();
};
const json=(records,extra={})=>JSON.stringify({status:'ok',records,...extra});

// A server checkout on commit "old" (branch main) with tag OLD in .env, and a newer commit "next" on the remote. 321 records are live.
function scenario(t,{preview=310,previewExtra,publicNew,files={},edge=false}={}){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-deploy-'));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const origin=path.join(base,'origin.git'),work=path.join(base,'work'),server=path.join(base,'server'),fake=path.join(base,'fake'),bin=path.join(base,'bin');
  for(const folder of [work,fake,bin])fs.mkdirSync(folder);
  git(base,'init','--bare','-q','-b','main',origin);git(work,'init','-q','-b','main');git(work,'remote','add','origin',origin);
  fs.writeFileSync(path.join(work,'a.txt'),'old\n');fs.mkdirSync(path.join(work,'docker'));fs.writeFileSync(path.join(work,'docker','Caddyfile'),'old edge\n');
  git(work,'add','.');git(work,'commit','-q','-m','old');git(work,'push','-q','origin','main');
  git(base,'clone','-q',origin,server);
  fs.writeFileSync(path.join(work,'a.txt'),'next\n');if(edge)fs.writeFileSync(path.join(work,'docker','Caddyfile'),'new edge\n');
  git(work,'commit','-q','-am','next');git(work,'push','-q','origin','main');
  const oldSha=git(server,'rev-parse','HEAD'),nextSha=git(work,'rev-parse','HEAD');
  const oldTag=git(server,'rev-parse','--short',oldSha);
  fs.writeFileSync(path.join(server,'.env'),`ACME_EMAIL=owner@example.org\nMINITANDEM_TAG=${oldTag}\n`);
  for(const [name,body] of Object.entries(TOOLS))fs.writeFileSync(path.join(bin,name),body,{mode:0o755});
  fs.writeFileSync(path.join(fake,'gh.json'),JSON.stringify([{conclusion:'success',status:'completed',headSha:nextSha}]));
  fs.writeFileSync(path.join(fake,'images'),oldTag+'\n');fs.writeFileSync(path.join(fake,'running'),oldTag);
  fs.writeFileSync(path.join(fake,'old-tag'),oldTag);
  // The image that was live before build-info.json existed answers with the record count only.
  fs.writeFileSync(path.join(fake,`public-${oldTag}.json`),json(321));
  // The new image: what its own preview says is also what the public site shows once it is switched (unless a test says otherwise).
  const newTag=git(work,'rev-parse','--short',nextSha);
  const previewAnswer=json(preview,{published:preview,archived:0,...(previewExtra??{revision:'0123456789abcdef',catalogueUpdated:'2026-10-15',commit:newTag})});
  fs.writeFileSync(path.join(fake,'preview.json'),previewAnswer);
  fs.writeFileSync(path.join(fake,`public-${newTag}.json`),publicNew??previewAnswer);
  for(const [name,body] of Object.entries(files))fs.writeFileSync(path.join(fake,name.replace('<new>',newTag).replace('<old>',oldTag)),body);
  const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,FAKE:fake,DEPLOY_HOST:'ubuntu@192.0.2.10',DEPLOY_KEY:path.join(base,'key'),DEPLOY_DIR:server,
    DEPLOY_URL:'https://site.test',DEPLOY_TRIES:'3',DEPLOY_POLL:'0.05'};
  const run=(...args)=>spawnSync(script,args,{env,encoding:'utf8'});
  const log=()=>fs.existsSync(path.join(fake,'log'))?fs.readFileSync(path.join(fake,'log'),'utf8').split('\n').filter(Boolean):[];
  const tagInEnv=()=>/^MINITANDEM_TAG=(.*)$/m.exec(fs.readFileSync(path.join(server,'.env'),'utf8'))[1];
  return {run,log,env,oldSha,nextSha,oldTag,newTag,tagInEnv,server,fake,
    running:()=>fs.readFileSync(path.join(fake,'running'),'utf8').trim(),
    previewUp:()=>fs.existsSync(path.join(fake,'preview-up')),
    branch:()=>git(server,'rev-parse','--abbrev-ref','HEAD'),head:()=>git(server,'rev-parse','HEAD')};
}
// The server is exactly as it was: same checkout on the branch, same tag, same running image, no preview left behind.
const untouched=s=>{
  assert.equal(s.branch(),'main');assert.equal(s.head(),s.oldSha);assert.equal(s.tagInEnv(),s.oldTag);assert.equal(s.running(),s.oldTag);assert.equal(s.previewUp(),false);
};

test('ops/deploy.sh refuses without exactly one full commit sha, and then touches neither GitHub nor the server',{skip:HAS_TOOLS?false:'bash or git is not installed'},t=>{
  const s=scenario(t);
  for(const args of [[],[s.nextSha,s.oldSha],['main'],[s.nextSha.slice(0,7)],[s.nextSha.toUpperCase()],[s.nextSha+'; rm -rf /']]){
    const result=s.run(...args);
    assert.notEqual(result.status,0,JSON.stringify(args));
    assert.match(result.stderr,/usage|not a full commit sha/,JSON.stringify(args));
  }
  assert.deepEqual(s.log(),[]);untouched(s);
});

test('ops/deploy.sh refuses unless GitHub CI succeeded for that exact commit',{skip:HAS_TOOLS?false:'bash or git is not installed'},t=>{
  for(const [answer,message] of [['[{"conclusion":"failure","status":"completed"}]',/not green/],['[]',/no CI run/],['[{"conclusion":"","status":"in_progress"}]',/not green/],
    ['[{"conclusion":"success","status":"completed"},{"conclusion":"cancelled","status":"completed"}]',/not green/]]){
    const s=scenario(t,{files:{'gh.json':answer}});
    const result=s.run(s.nextSha);
    assert.notEqual(result.status,0,answer);assert.match(result.stderr,message,answer);
    assert.deepEqual(s.log(),[`gh run list --repo avsomg/minitandem --workflow test.yml --commit ${s.nextSha} --limit 1 --json conclusion,status,headSha`],'only GitHub was asked, never the server');
    untouched(s);
  }
});

test('ops/deploy.sh refuses a preview with more than 15 % fewer records than the live site, cleans up and restores the checkout',{skip:HAS_TOOLS?false:'bash or git is not installed'},t=>{
  const s=scenario(t,{preview:257});                // 20 % fewer than the 321 that are live
  const result=s.run(s.nextSha);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/257 published cards is more than 15 % below the 321/);
  assert.match(result.stdout,new RegExp('Live now: tag '+s.oldTag));
  const log=s.log();
  assert.ok(log.includes('docker compose build app'),'the image was built and previewed first');
  assert.equal(log.filter(line=>line.startsWith('up ')).length,0,'the live service was never recreated');
  untouched(s);
  // The edge: 321 * 0.85 = 272.85, so 272 is more than 15 % below and 273 is not.
  const below=scenario(t,{preview:272}),edge=scenario(t,{preview:273});
  assert.notEqual(below.run(below.nextSha).status,0);untouched(below);
  const accepted=edge.run(edge.nextSha);assert.equal(accepted.status,0,accepted.stderr);assert.equal(edge.tagInEnv(),edge.newTag);
});

test('ops/deploy.sh previews the new image without the live state, switches, checks the public /healthz and prints the previous tag and the way back',{skip:HAS_TOOLS?false:'bash or git is not installed'},t=>{
  const s=scenario(t);
  const result=s.run(s.nextSha);
  assert.equal(result.status,0,result.stderr+result.stdout);
  assert.equal(s.tagInEnv(),s.newTag);assert.equal(s.running(),s.newTag);assert.equal(s.head(),s.nextSha);assert.equal(s.previewUp(),false,'the preview is removed');
  assert.match(result.stdout,new RegExp(`Previous tag: ${s.oldTag}`));
  const rollback=result.stdout.split('\n').find(line=>line.startsWith('Rollback:'));
  assert.ok(rollback,'the rollback command is printed');
  assert.match(rollback,/inspect .*deployments.*deployment lock/);
  const records=fs.readdirSync(path.join(s.server,'.deployments'));assert.equal(records.length,1);
  const record=fs.readFileSync(path.join(s.server,'.deployments',records[0]),'utf8');
  assert.ok(record.includes('previous_tag='+s.oldTag));assert.ok(record.includes('target_commit='+s.nextSha));assert.match(record,/stage=done/);
  assert.equal(fs.existsSync(path.join(s.server,'.deploy-lock')),false);
  // The image is built from the checkout, so what the deploy checks out stays readable for others; only its own records are private.
  for(const file of git(s.server,'diff','--name-only',s.oldSha,s.nextSha).split('\n').filter(Boolean))
    assert.ok(fs.statSync(path.join(s.server,file)).mode&0o004,`${file} is readable by the container user`);
  assert.equal(fs.statSync(path.join(s.server,'.deployments')).mode&0o777,0o700);
  const log=s.log();
  const at=prefix=>log.findIndex(line=>line.startsWith(prefix));
  assert.ok(at('gh run list')<at('ssh'),'CI is checked before the server is touched');
  assert.ok(at('docker compose build app')<at('docker run -d')&&at('docker run -d')<at('docker compose up'),'build, then preview, then switch');
  assert.ok(log.includes('up '+s.newTag));
  // The preview is bound to the server's loopback, runs with the live limits, and has a throw-away state: no named volume, no bind mount.
  const preview=log.find(line=>line.startsWith('docker run -d'));
  assert.match(preview,/-p 127\.0\.0\.1:18788:8787/);assert.match(preview,/--tmpfs \/state:/);assert.match(preview,/--read-only/);assert.match(preview,/--cap-drop ALL/);
  assert.match(preview,new RegExp(`-e MINITANDEM_COMMIT=${s.newTag} minitandem-app:${s.newTag}$`));
  assert.doesNotMatch(preview,/ -v |--volume|--mount|minitandem_state/);
  assert.equal(log.filter(line=>/^docker compose up/.test(line)).every(line=>line.includes('--no-build')),true,'the switch uses the image that was previewed');
});

test('ops/deploy.sh does nothing when the commit is already live',{skip:HAS_TOOLS?false:'bash or git is not installed'},t=>{
  const s=scenario(t);
  fs.writeFileSync(path.join(s.fake,'gh.json'),JSON.stringify([{conclusion:'success',status:'completed',headSha:s.oldSha}]));
  const result=s.run(s.oldSha);
  assert.equal(result.status,0);assert.match(result.stdout,/already live/);
  assert.equal(s.log().some(line=>line.startsWith('docker compose')),false);untouched(s);
});

test('ops/deploy.sh puts the previous tag and checkout back when the new container does not become healthy',{skip:HAS_TOOLS?false:'bash or git is not installed'},t=>{
  const s=scenario(t,{files:{'unhealthy-<new>':''}});
  const result=s.run(s.nextSha);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/did not become healthy/);
  assert.match(result.stdout,new RegExp(`Rolled back to tag ${s.oldTag}`));
  assert.deepEqual(s.log().filter(line=>line.startsWith('up ')),['up '+s.newTag,'up '+s.oldTag],'switched once, then back');
  untouched(s);
});

test('ops/deploy.sh rolls back when the public /healthz does not show the previewed build',{skip:HAS_TOOLS?false:'bash or git is not installed'},t=>{
  // Caddy still serves an older build (or the commit is missing): the revision is not the one that was previewed.
  const s=scenario(t,{publicNew:json(310,{revision:'ffffffffffffffff',catalogueUpdated:'2026-10-15',commit:'0000000'})});
  const result=s.run(s.nextSha);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/does not show the previewed build/);
  assert.match(result.stdout,/Rolled back to tag/);
  untouched(s);
});

test('ops/deploy.sh restores the checkout when the build fails, and refuses a preview that reports no revision',{skip:HAS_TOOLS?false:'bash or git is not installed'},t=>{
  const failing=scenario(t,{files:{'build-fails':''}});
  assert.notEqual(failing.run(failing.nextSha).status,0);untouched(failing);
  assert.equal(failing.log().some(line=>line.startsWith('docker run')),false,'nothing was previewed');
  const old=scenario(t,{previewExtra:{}});            // a commit from before build-info.json
  const result=old.run(old.nextSha);
  assert.notEqual(result.status,0);assert.match(result.stderr,/no record count or no revision/);untouched(old);
});

test('ops/deploy.sh refuses a checkout with uncommitted changes on the server',{skip:HAS_TOOLS?false:'bash or git is not installed'},t=>{
  const s=scenario(t);
  fs.writeFileSync(path.join(s.server,'a.txt'),'edited by hand\n');
  const result=s.run(s.nextSha);
  assert.notEqual(result.status,0);assert.match(result.stderr,/uncommitted changes/);
  assert.equal(s.log().some(line=>line.startsWith('docker')),false);
});
// Generous on purpose: the whole suite runs files in parallel, also inside the editorial cycle's QA on a busy Mac. A success returns at once.
const waitFor=async(predicate,ms=30000)=>{
  for(const end=Date.now()+ms;Date.now()<end;){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.fail('fixture process did not reach its expected state');
};
function background(s){
  const child=spawn(script,[s.nextSha],{env:s.env,stdio:['ignore','pipe','pipe']});let output='';
  child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',(code,signal)=>resolve({code,signal,output}));});
  return {child,done};
}
test('one SSH operation holds the server lock throughout build and refuses a concurrent deploy immediately',{skip:HAS_TOOLS?false:'bash or git is not installed'},async t=>{
  const s=scenario(t,{files:{'wait-build':''}}),first=background(s);
  t.after(()=>{if(fs.existsSync(s.fake))fs.writeFileSync(path.join(s.fake,'release-build'),'');first.child.kill();});
  await waitFor(()=>fs.existsSync(path.join(s.fake,'build-entered')));
  const second=s.run(s.nextSha);assert.notEqual(second.status,0);assert.match(second.stderr,/another operation owns the lock/);
  assert.equal(s.log().filter(row=>row==='docker compose build app').length,1);
  fs.writeFileSync(path.join(s.fake,'release-build'),'');assert.equal((await first.done).code,0);
  assert.equal(fs.existsSync(path.join(s.server,'.deploy-lock')),false);
});
test('an interrupted server operation leaves its previous and target versions for explicit recovery',{skip:HAS_TOOLS?false:'bash or git is not installed'},async t=>{
  const s=scenario(t,{files:{'wait-build':''}}),first=background(s);
  t.after(()=>{if(fs.existsSync(s.fake))fs.writeFileSync(path.join(s.fake,'release-build'),'');first.child.kill();});
  await waitFor(()=>fs.existsSync(path.join(s.fake,'build-entered')));
  const owner=fs.readFileSync(path.join(s.server,'.deploy-lock','owner'),'utf8'),pid=Number(/^pid=(\d+)$/m.exec(owner)[1]);
  process.kill(pid,'SIGKILL');fs.writeFileSync(path.join(s.fake,'release-build'),'');
  assert.notEqual((await first.done).code,0);
  const id=fs.readFileSync(path.join(s.server,'.deploy-lock','id'),'utf8').trim(),record=fs.readFileSync(path.join(s.server,'.deployments',id),'utf8');
  assert.match(record,/stage=checkout/);assert.ok(record.includes('previous_tag='+s.oldTag));assert.ok(record.includes('target_commit='+s.nextSha));
  assert.notEqual(s.run(s.nextSha).status,0,'a stale lock is not silently stolen');
});
test('a late failure cannot clean up or roll back an operation whose ownership changed',{skip:HAS_TOOLS?false:'bash or git is not installed'},t=>{
  const s=scenario(t,{files:{'steal-owner':''}}),result=s.run(s.nextSha);
  assert.notEqual(result.status,0);assert.match(result.stderr,/ownership changed/);
  assert.equal(s.running(),s.newTag);assert.equal(s.tagInEnv(),s.newTag);
  assert.equal(fs.readFileSync(path.join(s.server,'.deploy-lock','id'),'utf8').trim(),'replacement');
  assert.equal(s.log().filter(row=>row==='up '+s.oldTag).length,0);
});
test('a successful workflow for a different head never satisfies the named exact-commit check',{skip:HAS_TOOLS?false:'bash or git is not installed'},t=>{
  const s=scenario(t);fs.writeFileSync(path.join(s.fake,'gh.json'),JSON.stringify([{headSha:s.oldSha,status:'completed',conclusion:'success'}]));
  assert.notEqual(s.run(s.nextSha).status,0);assert.equal(s.log().some(row=>row.startsWith('ssh')),false);
});
test('published-count shrink catches mass archival even when the total record count is unchanged',{skip:HAS_TOOLS?false:'bash or git is not installed'},t=>{
  const s=scenario(t,{preview:321});
  fs.writeFileSync(path.join(s.fake,`public-${s.oldTag}.json`),json(321,{published:295,archived:26}));
  const preview=json(321,{published:240,archived:81,revision:'0123456789abcdef',commit:s.newTag});
  fs.writeFileSync(path.join(s.fake,'preview.json'),preview);
  const result=s.run(s.nextSha);assert.notEqual(result.status,0);assert.match(result.stderr,/240 published cards/);
  assert.match(result.stdout,/published 295 -> 240; archived 26 -> 81/);untouched(s);
});
test('the published-count boundary is exact and legacy live images print their fallback warning',{skip:HAS_TOOLS?false:'bash or git is not installed'},t=>{
  for(const [published,accepted] of [[250,false],[251,true]]){
    const s=scenario(t,{preview:321});
    fs.writeFileSync(path.join(s.fake,`public-${s.oldTag}.json`),json(321,{published:295,archived:26}));
    const preview=json(321,{published,archived:321-published,revision:'0123456789abcdef',commit:s.newTag});
    fs.writeFileSync(path.join(s.fake,'preview.json'),preview);fs.writeFileSync(path.join(s.fake,`public-${s.newTag}.json`),preview);
    assert.equal(s.run(s.nextSha).status===0,accepted);
  }
  const legacy=scenario(t),result=legacy.run(legacy.nextSha);assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/live image has no published count; using records/);
});

test('a changed Caddyfile is validated before the switch and Caddy is recreated with it; an unchanged one leaves Caddy alone',{skip:HAS_TOOLS?false:'bash or git is not installed'},t=>{
  const plain=scenario(t);assert.equal(plain.run(plain.nextSha).status,0);
  assert.equal(plain.log().some(line=>line.includes('force-recreate caddy')||line.startsWith('docker compose run')),false);
  const edge=scenario(t,{edge:true});const result=edge.run(edge.nextSha);assert.equal(result.status,0,result.stderr);
  const log=edge.log(),at=prefix=>log.findIndex(line=>line.startsWith(prefix));
  assert.ok(at('docker compose run')>=0&&at('docker compose run')<at('docker compose up -d --no-build'),'validated before the switch');
  assert.ok(log.includes('docker compose up -d --no-build --force-recreate caddy'),'Caddy recreated');
  const broken=scenario(t,{edge:true,files:{'caddy-invalid':''}});const refused=broken.run(broken.nextSha);
  assert.notEqual(refused.status,0);assert.match(refused.stderr,/does not validate/);assert.equal(broken.tagInEnv(),broken.oldTag);
});
