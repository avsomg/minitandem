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
echo "curl $last" >> "$FAKE/log"
headers=0 format= before=
for argument; do [ "$before" = -D ] && headers=1; [ "$before" = -w ] && format=$argument; before=$argument; done
# What the files of a site answer in their headers; a test can take one header away or add Via.
answer_headers() {
  drop=$(cat "$FAKE/drop-header" 2>/dev/null)
  case "$last" in https://*) drop=$(cat "$FAKE/drop-header-live" 2>/dev/null) ;; esac
  for name in content-security-policy strict-transport-security x-content-type-options x-frame-options referrer-policy permissions-policy cross-origin-opener-policy cross-origin-resource-policy cache-control; do
    [ "$drop" = "$name" ] || echo "$name: x"
  done
  [ -f "$FAKE/add-via" ] && echo "Via: 1.1 Caddy"
  case "$last" in
    */sw.js) type=text/javascript ;; */sitemap.xml) type=application/xml ;; */robots.txt) type=text/plain ;; */manifest.webmanifest) type=application/manifest+json ;; *) type=text/html ;;
  esac
  [ "$(cat "$FAKE/wrong-type" 2>/dev/null)" = "$(basename "$last")" ] && type=application/octet-stream
  echo "Content-Type: $type; charset=utf-8"
}
if [ -n "$format" ]; then
  # Only the status of an editor path is asked for.
  case "$last" in
    */projekt) cat "$FAKE/folder-status" 2>/dev/null || echo 301 ;;
    */api/v1/family) cat "$FAKE/api-status" 2>/dev/null || echo 503 ;;
    *) cat "$FAKE/editor-status" 2>/dev/null || echo 404 ;;
  esac
  exit 0
fi
case "$last" in
  http://127.0.0.1:*/build-info.json) [ -f "$FAKE/preview-up" ] || exit 7; cat "$FAKE/preview-files.json" ;;
  http://127.0.0.1:*/healthz) [ -f "$FAKE/preview-up" ] && [ -f "$FAKE/preview-api-up" ] || exit 7; cat "$FAKE/preview.json" ;;
  http://127.0.0.1:*) [ -f "$FAKE/preview-up" ] || exit 7; if [ "$headers" = 1 ]; then answer_headers; else printf 'content-of-%s' "$(basename "$last")"; fi ;;
  */build-info.json) f="$FAKE/public-files-$(cat "$FAKE/static-running").json"; [ -f "$f" ] || exit 22; cat "$f" ;;
  */healthz)
    if [ -f "$FAKE/steal-owner" ] && [ -d "$DEPLOY_DIR/.deploy-lock" ]; then
      current=$(sed -n 's/^MINITANDEM_TAG=//p' "$DEPLOY_DIR/.env")
      if [ "$current" != "$(cat "$FAKE/old-tag")" ]; then echo replacement > "$DEPLOY_DIR/.deploy-lock/id"; exit 22; fi
    fi
    f="$FAKE/public-$(cat "$FAKE/running").json"; [ -f "$f" ] || exit 22; cat "$f" ;;
  https://site.test/*) if [ "$headers" = 1 ]; then answer_headers; else exit 6; fi ;;
  *) exit 6 ;;
esac
`,
  docker:`#!/bin/sh
echo "docker $*" >> "$FAKE/log"
case "$1 $2" in
  "compose build")
    if [ -f "$FAKE/wait-build" ]; then touch "$FAKE/build-entered"; while [ ! -f "$FAKE/release-build" ]; do sleep 0.02; done; fi
    [ -f "$FAKE/build-fails" ] && { echo "build failed" >&2; exit 1; }
    [ -f "$FAKE/build-reads-stdin" ] && cat >/dev/null
    echo "$MINITANDEM_TAG" >> "$FAKE/images" ;;
  "compose up")
    tag=$(sed -n 's/^MINITANDEM_TAG=//p' .env)
    case "$*" in *--no-build*) grep -qx "$tag" "$FAKE/images" || { echo "image missing" >&2; exit 1; } ;; esac
    echo "$tag" > "$FAKE/running"
    # The files follow the tag, unless a test keeps the old files in front (the old Caddy still serving) until the way back.
    if [ ! -f "$FAKE/static-stale" ] || [ "$tag" = "$(cat "$FAKE/old-tag")" ]; then echo "$tag" > "$FAKE/static-running"; fi
    if [ -f "$FAKE/bad-rollback-files" ] && [ "$tag" = "$(cat "$FAKE/old-tag")" ]; then echo '{}' > "$FAKE/public-files-$tag.json"; fi
    echo "up $tag" >> "$FAKE/log" ;;
  "compose ps") echo app-container ;;
  # As the real one: compose run reads stdin, where the deploy program arrives through ssh.
  "compose run") cat >/dev/null; echo "validated with tag $MINITANDEM_TAG" >> "$FAKE/log"; [ -f "$FAKE/caddy-invalid" ] && { echo "invalid Caddyfile" >&2; exit 1; }; echo "Valid configuration" ;;
  "image inspect") grep -qx "$(echo "$3" | sed 's/^minitandem-app://')" "$FAKE/images" ;;
  "rm -f") rm -f "$FAKE/preview-up" "$FAKE/preview-api-up" ;;
  "network create") touch "$FAKE/preview-network" ;;
  "network rm") rm -f "$FAKE/preview-network" ;;
  "run --rm")
    # The digest of a file inside the image of the API; the fake curl serves the same text for it.
    for file; do :; done; name=$(basename "$file"); served=$name; [ -f "$FAKE/bad-digest" ] && served=another-$name
    printf 'content-of-%s' "$served" | sha256sum | sed "s| .*|  .publish/$name|" ;;
  "run -d")
    case "$*" in *minitandem-app:*) touch "$FAKE/preview-api-up";; esac
    case "$*" in *" -p "*) touch "$FAKE/preview-up";; esac
    echo container-id ;;
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
// `split` makes "next" a release with Caddy images (its compose.yaml builds minitandem-caddy), `oldSplit` the same for "old";
// without them a release is one from before the Caddy images, previewed as a single container as it always was.
// `edge` changes docker/Caddyfile in "next"; `edgeFile` changes another file that Caddy reads.
function scenario(t,{preview=310,previewExtra,publicNew,previewFiles,publicFiles,files={},edge=false,edgeFile,split=false,oldSplit=false}={}){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-deploy-'));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const origin=path.join(base,'origin.git'),work=path.join(base,'work'),server=path.join(base,'server'),fake=path.join(base,'fake'),bin=path.join(base,'bin');
  for(const folder of [work,fake,bin])fs.mkdirSync(folder);
  git(base,'init','--bare','-q','-b','main',origin);git(work,'init','-q','-b','main');git(work,'remote','add','origin',origin);
  const compose=isSplit=>isSplit?'services:\n  caddy:\n    image: minitandem-caddy:${MINITANDEM_TAG:-current}\n':'services:\n  caddy:\n    image: caddy:2.11.7-alpine\n';
  fs.writeFileSync(path.join(work,'a.txt'),'old\n');fs.writeFileSync(path.join(work,'compose.yaml'),compose(oldSplit));fs.mkdirSync(path.join(work,'docker'));
  for(const file of ['Caddyfile','site.caddy','preview.Caddyfile','access-log-entrypoint.sh'])fs.writeFileSync(path.join(work,'docker',file),'old '+file+'\n');
  git(work,'add','.');git(work,'commit','-q','-m','old');git(work,'push','-q','origin','main');
  git(base,'clone','-q',origin,server);
  fs.writeFileSync(path.join(work,'a.txt'),'next\n');fs.writeFileSync(path.join(work,'compose.yaml'),compose(split));
  if(edge)fs.writeFileSync(path.join(work,'docker','Caddyfile'),'new edge\n');
  if(edgeFile)fs.writeFileSync(path.join(work,'docker',edgeFile),'new '+edgeFile+'\n');
  git(work,'commit','-q','-am','next');git(work,'push','-q','origin','main');
  const oldSha=git(server,'rev-parse','HEAD'),nextSha=git(work,'rev-parse','HEAD');
  const oldTag=git(server,'rev-parse','--short',oldSha);
  fs.writeFileSync(path.join(server,'.env'),`ACME_EMAIL=owner@example.org\nMINITANDEM_TAG=${oldTag}\n`);
  for(const [name,body] of Object.entries(TOOLS))fs.writeFileSync(path.join(bin,name),body,{mode:0o755});
  fs.writeFileSync(path.join(fake,'gh.json'),JSON.stringify([{conclusion:'success',status:'completed',headSha:nextSha}]));
  fs.writeFileSync(path.join(fake,'images'),oldTag+'\n');fs.writeFileSync(path.join(fake,'running'),oldTag);
  fs.writeFileSync(path.join(fake,'old-tag'),oldTag);
  fs.writeFileSync(path.join(fake,'static-running'),oldTag);
  // The image that was live before build-info.json existed answers with the record count only. Its files (served by the service then)
  // have their own build-info.json, without a commit.
  fs.writeFileSync(path.join(fake,`public-${oldTag}.json`),json(321));
  fs.writeFileSync(path.join(fake,`public-files-${oldTag}.json`),JSON.stringify({revision:'old-catalogue',records:321},null,2));
  // The new image: what its own preview says is also what the public site shows once it is switched (unless a test says otherwise).
  const newTag=git(work,'rev-parse','--short',nextSha);
  const previewAnswer=json(preview,{published:preview,archived:0,...(previewExtra??{revision:'0123456789abcdef',catalogueUpdated:'2026-10-15',commit:newTag})});
  fs.writeFileSync(path.join(fake,'preview.json'),previewAnswer);
  // The files of the new release say the same as its API (build-info.json is indented JSON, /healthz is one line).
  fs.writeFileSync(path.join(fake,'preview-files.json'),previewFiles??JSON.stringify(JSON.parse(previewAnswer),null,2));
  fs.writeFileSync(path.join(fake,`public-files-${newTag}.json`),publicFiles??JSON.stringify(JSON.parse(previewAnswer),null,2));
  fs.writeFileSync(path.join(fake,`public-${newTag}.json`),publicNew??previewAnswer);
  for(const [name,body] of Object.entries(files))fs.writeFileSync(path.join(fake,name.replace('<new>',newTag).replace('<old>',oldTag)),body);
  const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,FAKE:fake,DEPLOY_HOST:'ubuntu@192.0.2.10',DEPLOY_KEY:path.join(base,'key'),DEPLOY_DIR:server,
    DEPLOY_URL:'https://site.test',DEPLOY_TRIES:'3',DEPLOY_POLL:'0.05'};
  const run=(...args)=>spawnSync(script,args,{env,encoding:'utf8'});
  const log=()=>fs.existsSync(path.join(fake,'log'))?fs.readFileSync(path.join(fake,'log'),'utf8').split('\n').filter(Boolean):[];
  const tagInEnv=()=>/^MINITANDEM_TAG=(.*)$/m.exec(fs.readFileSync(path.join(server,'.env'),'utf8'))[1];
  return {run,log,env,oldSha,nextSha,oldTag,newTag,tagInEnv,server,fake,
    running:()=>fs.readFileSync(path.join(fake,'running'),'utf8').trim(),
    staticRunning:()=>fs.readFileSync(path.join(fake,'static-running'),'utf8').trim(),
    previewUp:()=>fs.existsSync(path.join(fake,'preview-up')),
    branch:()=>git(server,'rev-parse','--abbrev-ref','HEAD'),head:()=>git(server,'rev-parse','HEAD')};
}
// The server is exactly as it was: same checkout on the branch, same tag, same running image, no preview left behind.
const untouched=s=>{
  assert.equal(s.branch(),'main');assert.equal(s.head(),s.oldSha);assert.equal(s.tagInEnv(),s.oldTag);assert.equal(s.running(),s.oldTag);assert.equal(s.staticRunning(),s.oldTag);assert.equal(s.previewUp(),false);
  for(const file of ['preview-api-up','preview-network'])assert.equal(fs.existsSync(path.join(s.fake,file)),false,file+' is gone');
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

test('a changed file that Caddy reads (the routes, the preview file or the log script) is validated before the switch and Caddy is recreated, as the Caddyfile is',{skip:HAS_TOOLS?false:'bash or git is not installed'},t=>{
  for(const edgeFile of ['site.caddy','preview.Caddyfile','access-log-entrypoint.sh']){
    const s=scenario(t,{edgeFile}),result=s.run(s.nextSha);assert.equal(result.status,0,edgeFile+result.stderr);
    const log=s.log(),at=prefix=>log.findIndex(line=>line.startsWith(prefix));
    assert.ok(at('docker compose run')>=0&&at('docker compose run')<at('docker compose up -d --no-build'),edgeFile+' validated before the switch');
    assert.ok(log.includes('docker compose up -d --no-build --force-recreate caddy'),edgeFile+' Caddy recreated');
  }
});

// ---- a release with Caddy images: the files and the API of one tag, previewed together, switched together, rolled back together
const split=(t,options={})=>scenario(t,{split:true,...options});

test('a release with Caddy images builds both images, previews Caddy and the API on a private network, validates the Caddyfile with the new image and switches both',{skip:HAS_TOOLS?false:'bash or git is not installed'},t=>{
  const s=split(t),result=s.run(s.nextSha);
  assert.equal(result.status,0,result.stderr+result.stdout);
  assert.equal(s.tagInEnv(),s.newTag);assert.equal(s.running(),s.newTag);assert.equal(s.staticRunning(),s.newTag);assert.equal(s.previewUp(),false);
  for(const file of ['preview-api-up','preview-network'])assert.equal(fs.existsSync(path.join(s.fake,file)),false,file+' is removed');
  const log=s.log(),at=prefix=>log.findIndex(line=>line.startsWith(prefix));
  assert.ok(log.includes('docker compose build app caddy'),'both images are built');
  assert.equal(log.includes('docker compose build app'),false);
  const previews=log.filter(line=>line.startsWith('docker run -d'));assert.equal(previews.length,2);
  const [api,edge]=previews;
  // The API: private network, the name "app" that the Caddyfile proxies to, no published port, throw-away state, and it serves no public file itself.
  assert.match(api,/--network minitandem-preview-net-\S+ --network-alias app /);assert.doesNotMatch(api,/ -p /);assert.match(api,/--tmpfs \/state:/);
  assert.match(api,new RegExp(`-e MINITANDEM_API_ONLY=1 -e MINITANDEM_COMMIT=${s.newTag} minitandem-app:${s.newTag}$`));
  // Caddy: the image of the same tag, the preview file, the only published port (on the loopback), no persistent volume.
  assert.match(edge,/-p 127\.0\.0\.1:18788:8080/);
  // The Caddy binary starts only with the capability it carries as a file capability; the API keeps none.
  assert.match(edge,/--cap-drop ALL --cap-add NET_BIND_SERVICE /);assert.doesNotMatch(api,/--cap-add/);assert.match(edge,new RegExp(`minitandem-caddy:${s.newTag} caddy run --config /etc/caddy/preview\\.Caddyfile --adapter caddyfile$`));
  for(const preview of previews){assert.match(preview,/--read-only/);assert.match(preview,/--cap-drop ALL/);assert.doesNotMatch(preview,/ -v |--volume|--mount|minitandem_state|caddy-data/);}
  // The files and the API of the preview are checked against each other before anything is switched.
  assert.ok(log.includes('curl http://127.0.0.1:18788/build-info.json'));
  for(const file of ['index.html','app.js','sw.js','styles.css','sitemap.xml'])assert.ok(log.includes('curl http://127.0.0.1:18788/'+file),file);
  assert.ok(log.some(line=>line.startsWith('docker run --rm')&&line.includes('--entrypoint sha256sum')&&line.includes(`minitandem-app:${s.newTag} .publish/index.html`)));
  // The real Caddyfile is validated with the image of the new tag (the tag in .env is still the old one at that moment), before the switch.
  assert.ok(log.includes(`validated with tag ${s.newTag}`));
  assert.ok(at('docker compose build')<at('docker network create')&&at('docker network create')<at('docker run -d')&&at('docker run -d')<at('docker compose run')&&at('docker compose run')<at('docker compose up'),'build, preview, validate, switch');
  assert.ok(log.includes('curl https://site.test/build-info.json'),'the public files are checked after the switch');
  assert.equal(log.filter(line=>/^docker compose up/.test(line)).every(line=>line.includes('--no-build')),true,'the switch uses the images that were previewed');
  assert.equal(log.includes('docker compose up -d --no-build --force-recreate caddy'),false,'the new image tag recreates Caddy by itself');
  assert.match(result.stdout,/Preview files: same build and commit as the API/);
});

test('a command that reads the rest of the program from stdin makes the deployment fail, not succeed, and the checkout returns',{skip:HAS_TOOLS?false:'bash or git is not installed'},t=>{
  const s=split(t);fs.writeFileSync(path.join(s.fake,'build-reads-stdin'),'');
  const result=s.run(s.nextSha);
  assert.notEqual(result.status,0,result.stdout);assert.match(result.stderr,/ended at stage checkout without finishing/);
  assert.equal(s.tagInEnv(),s.oldTag);assert.equal(s.running(),s.oldTag);assert.equal(git(s.server,'rev-parse','HEAD'),s.oldSha);
  assert.equal(s.log().some(line=>line.startsWith('docker compose up')),false,'nothing was switched');
  const records=fs.readdirSync(path.join(s.server,'.deployments'));
  assert.match(fs.readFileSync(path.join(s.server,'.deployments',records[0]),'utf8'),/stage=rolled-back/);
  assert.equal(fs.existsSync(path.join(s.server,'.deploy-lock')),false,'the lock is released');
});

test('the preview of a release with Caddy images refuses files that do not match its API, before anything is switched',{skip:HAS_TOOLS?false:'bash or git is not installed'},t=>{
  // Another catalogue revision, another record count, another commit, or no commit at all in the files.
  const api={status:'ok',records:310,published:310,archived:0,revision:'0123456789abcdef',catalogueUpdated:'2026-10-15'};
  for(const [files,key] of [[{...api,revision:'ffffffffffffffff'},'revision'],[{...api,records:300,published:300},'records'],[{...api,commit:'0000000'},'commit'],[api,'commit'],[{},'revision']]){
    const s=split(t,{previewExtra:{revision:api.revision,catalogueUpdated:api.catalogueUpdated,commit:'%NEW%'},previewFiles:'%FILES%'});
    const tag=s.newTag;
    fs.writeFileSync(path.join(s.fake,'preview.json'),JSON.stringify({...api,commit:tag}));
    fs.writeFileSync(path.join(s.fake,'preview-files.json'),JSON.stringify(files.commit==='%NEW%'?{...files,commit:tag}:files,null,2));
    const result=s.run(s.nextSha);
    assert.notEqual(result.status,0,key);assert.match(result.stderr,new RegExp('disagree with its API: '+key),key);
    assert.equal(s.log().some(line=>line.startsWith('up ')||line.startsWith('docker compose up')),false,'the live pair was not touched');untouched(s);
  }
  const wrong=split(t,{previewExtra:{revision:'0123456789abcdef',commit:'wrong'}}),refused=wrong.run(wrong.nextSha);
  assert.notEqual(refused.status,0);assert.match(refused.stderr,/another commit than the one being deployed/);untouched(wrong);
});

test('the preview refuses a file that differs from the one inside the API image, a missing security header, a Via header and an editor path that is served',{skip:HAS_TOOLS?false:'bash or git is not installed'},t=>{
  const digest=split(t,{files:{'bad-digest':''}}),a=digest.run(digest.nextSha);
  assert.notEqual(a.status,0);assert.match(a.stderr,/serves another index\.html than the image of the API/);untouched(digest);
  for(const name of ['content-security-policy','strict-transport-security','x-content-type-options','x-frame-options','referrer-policy','permissions-policy','cross-origin-opener-policy','cross-origin-resource-policy','cache-control']){
    const s=split(t,{files:{'drop-header':name}}),result=s.run(s.nextSha);
    assert.notEqual(result.status,0,name);assert.match(result.stderr,new RegExp('served without '+name),name);untouched(s);
  }
  const via=split(t,{files:{'add-via':''}}),b=via.run(via.nextSha);
  assert.notEqual(b.status,0);assert.match(b.stderr,/served with a Via header/);untouched(via);
  const editor=split(t,{files:{'editor-status':'200'}}),c=editor.run(editor.nextSha);
  assert.notEqual(c.status,0);assert.match(c.stderr,/is not refused with 404/);untouched(editor);
  // The type of a file (a service worker served as octet-stream stops working under nosniff), the redirect of a folder, and the way to the service.
  const type=split(t,{files:{'wrong-type':'sw.js'}}),d=type.run(type.nextSha);
  assert.notEqual(d.status,0);assert.match(d.stderr,/\/sw\.js is not served as text\/javascript/);untouched(type);
  const folder=split(t,{files:{'folder-status':'200'}}),e=folder.run(folder.nextSha);
  assert.notEqual(e.status,0);assert.match(e.stderr,/\/projekt is not redirected with 301/);untouched(folder);
  const api=split(t,{files:{'api-status':'404'}}),f=api.run(api.nextSha);
  assert.notEqual(f.status,0);assert.match(f.stderr,/does not reach the service \(answer 404\)/);untouched(api);
});

test('a Caddyfile that the new Caddy image does not accept stops a release with Caddy images before the switch',{skip:HAS_TOOLS?false:'bash or git is not installed'},t=>{
  const s=split(t,{files:{'caddy-invalid':''}}),result=s.run(s.nextSha);
  assert.notEqual(result.status,0);assert.match(result.stderr,/does not validate/);assert.match(result.stderr,/invalid Caddyfile/,'the validator\'s own message is shown');
  assert.equal(s.tagInEnv(),s.oldTag);untouched(s);
});

test('a healthy new API with the old public files in front rolls back both, and the old files are checked again',{skip:HAS_TOOLS?false:'bash or git is not installed'},t=>{
  // Caddy keeps serving the old files after the switch: /healthz shows the new build, /build-info.json does not.
  const s=split(t,{files:{'static-stale':''}}),result=s.run(s.nextSha);
  assert.notEqual(result.status,0);assert.match(result.stderr,/does not show the previewed build/);
  assert.match(result.stdout,/Rolled back to tag/);untouched(s);
  assert.deepEqual(s.log().filter(line=>line.startsWith('up ')),['up '+s.newTag,'up '+s.oldTag],'switched once, then back');
});

test('a code-only release is not accepted with the files of the old commit, even when the catalogue revision is the same',{skip:HAS_TOOLS?false:'bash or git is not installed'},t=>{
  const files=JSON.stringify({status:'ok',records:310,published:310,archived:0,revision:'0123456789abcdef',catalogueUpdated:'2026-10-15',commit:'oldcode'},null,2);
  const s=split(t,{publicFiles:files}),result=s.run(s.nextSha);
  assert.notEqual(result.status,0);assert.match(result.stdout,/Rolled back to tag/);untouched(s);
});

test('a public edge that answers without a security header after the switch is rolled back',{skip:HAS_TOOLS?false:'bash or git is not installed'},t=>{
  // The preview was fine; the live site (certificates, log, the real Caddyfile) is not.
  const s=split(t,{files:{'drop-header-live':'x-frame-options'}}),result=s.run(s.nextSha);
  assert.notEqual(result.status,0);assert.match(result.stderr,/https:\/\/site\.test\/ is served without x-frame-options/);assert.match(result.stdout,/Rolled back to tag/);untouched(s);
  assert.deepEqual(s.log().filter(line=>line.startsWith('up ')),['up '+s.newTag,'up '+s.oldTag],'switched once, then back');
});

test('a planned rollback from a release with Caddy images to one before them previews the single-container way and restores the old files',{skip:HAS_TOOLS?false:'bash or git is not installed'},t=>{
  // "old" is the release before the Caddy images; the server runs "next", which has them. The way back is a new deployment of "old".
  const s=split(t,{edge:true});assert.equal(s.run(s.nextSha).status,0);
  fs.writeFileSync(path.join(s.fake,'gh.json'),JSON.stringify([{headSha:s.oldSha,status:'completed',conclusion:'success'}]));
  const api={status:'ok',records:321,published:295,archived:26,revision:'old-catalogue',commit:s.oldTag};
  fs.writeFileSync(path.join(s.fake,'preview.json'),JSON.stringify(api));
  fs.writeFileSync(path.join(s.fake,`public-${s.oldTag}.json`),JSON.stringify(api));
  fs.writeFileSync(path.join(s.fake,`public-files-${s.oldTag}.json`),JSON.stringify({revision:'old-catalogue',records:321,published:295,archived:26},null,2));
  const before=s.log().length;
  const result=s.run(s.oldSha);assert.equal(result.status,0,result.stderr+result.stdout);
  assert.equal(s.running(),s.oldTag);assert.equal(s.staticRunning(),s.oldTag);assert.equal(s.head(),s.oldSha);assert.equal(s.tagInEnv(),s.oldTag);
  const log=s.log().slice(before);
  assert.ok(log.includes('docker compose build app'),'only the API image exists for a release before the Caddy images');
  const previews=log.filter(line=>line.startsWith('docker run -d'));assert.equal(previews.length,1);assert.match(previews[0],/-p 127\.0\.0\.1:18788:8787/);
  assert.equal(log.some(line=>line.startsWith('docker network create')),false);
  // The Caddyfile differs between the two releases: it is validated with the old release's own Caddy image and Caddy is recreated, as before the Caddy images.
  assert.ok(log.some(line=>line.startsWith('docker compose run')));assert.ok(log.includes('docker compose up -d --no-build --force-recreate caddy'));
});

test('a failed rollback leaves recovery locked when the old API is back but the old files cannot be verified',{skip:HAS_TOOLS?false:'bash or git is not installed'},t=>{
  const s=split(t,{files:{'static-stale':'','bad-rollback-files':''}}),result=s.run(s.nextSha);
  assert.notEqual(result.status,0);assert.match(result.stderr,/ROLLBACK FAILED/);
  assert.equal(s.running(),s.oldTag);
  assert.equal(fs.existsSync(path.join(s.server,'.deploy-lock')),true);
  const id=fs.readFileSync(path.join(s.server,'.deploy-lock','id'),'utf8').trim();
  assert.match(fs.readFileSync(path.join(s.server,'.deployments',id),'utf8'),/stage=recovery-needed/);
});
