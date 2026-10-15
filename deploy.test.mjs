import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
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
  */healthz) f="$FAKE/public-$(cat "$FAKE/running").json"; [ -f "$f" ] || exit 22; cat "$f" ;;
  *) exit 6 ;;
esac
`,
  docker:`#!/bin/sh
echo "docker $*" >> "$FAKE/log"
case "$1 $2" in
  "compose build")
    [ -f "$FAKE/build-fails" ] && { echo "build failed" >&2; exit 1; }
    echo "$MINITANDEM_TAG" >> "$FAKE/images" ;;
  "compose up")
    tag=$(sed -n 's/^MINITANDEM_TAG=//p' .env)
    case "$*" in *--no-build*) grep -qx "$tag" "$FAKE/images" || { echo "image missing" >&2; exit 1; } ;; esac
    echo "$tag" > "$FAKE/running"; echo "up $tag" >> "$FAKE/log" ;;
  "compose ps") echo app-container ;;
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
function scenario(t,{preview=310,previewExtra,publicNew,files={}}={}){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'minitandem-deploy-'));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const origin=path.join(base,'origin.git'),work=path.join(base,'work'),server=path.join(base,'server'),fake=path.join(base,'fake'),bin=path.join(base,'bin');
  for(const folder of [work,fake,bin])fs.mkdirSync(folder);
  git(base,'init','--bare','-q','-b','main',origin);git(work,'init','-q','-b','main');git(work,'remote','add','origin',origin);
  fs.writeFileSync(path.join(work,'a.txt'),'old\n');git(work,'add','.');git(work,'commit','-q','-m','old');git(work,'push','-q','origin','main');
  git(base,'clone','-q',origin,server);
  fs.writeFileSync(path.join(work,'a.txt'),'next\n');git(work,'commit','-q','-am','next');git(work,'push','-q','origin','main');
  const oldSha=git(server,'rev-parse','HEAD'),nextSha=git(work,'rev-parse','HEAD');
  const oldTag=git(server,'rev-parse','--short',oldSha);
  fs.writeFileSync(path.join(server,'.env'),`ACME_EMAIL=owner@example.org\nMINITANDEM_TAG=${oldTag}\n`);
  for(const [name,body] of Object.entries(TOOLS))fs.writeFileSync(path.join(bin,name),body,{mode:0o755});
  fs.writeFileSync(path.join(fake,'gh.json'),'[{"conclusion":"success","status":"completed"}]');
  fs.writeFileSync(path.join(fake,'images'),oldTag+'\n');fs.writeFileSync(path.join(fake,'running'),oldTag);
  // The image that was live before build-info.json existed answers with the record count only.
  fs.writeFileSync(path.join(fake,`public-${oldTag}.json`),json(321));
  // The new image: what its own preview says is also what the public site shows once it is switched (unless a test says otherwise).
  const newTag=git(work,'rev-parse','--short',nextSha);
  const previewAnswer=json(preview,previewExtra??{revision:'0123456789abcdef',catalogueUpdated:'2026-10-15',commit:newTag});
  fs.writeFileSync(path.join(fake,'preview.json'),previewAnswer);
  fs.writeFileSync(path.join(fake,`public-${newTag}.json`),publicNew??previewAnswer);
  for(const [name,body] of Object.entries(files))fs.writeFileSync(path.join(fake,name.replace('<new>',newTag).replace('<old>',oldTag)),body);
  const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,FAKE:fake,DEPLOY_HOST:'ubuntu@192.0.2.10',DEPLOY_KEY:path.join(base,'key'),DEPLOY_DIR:server,
    DEPLOY_URL:'https://site.test',DEPLOY_TRIES:'3',DEPLOY_POLL:'0.05'};
  const run=(...args)=>spawnSync(script,args,{env,encoding:'utf8'});
  const log=()=>fs.existsSync(path.join(fake,'log'))?fs.readFileSync(path.join(fake,'log'),'utf8').split('\n').filter(Boolean):[];
  const tagInEnv=()=>/^MINITANDEM_TAG=(.*)$/m.exec(fs.readFileSync(path.join(server,'.env'),'utf8'))[1];
  return {run,log,oldSha,nextSha,oldTag,newTag,tagInEnv,server,fake,
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
    assert.deepEqual(s.log(),[`gh run list --repo avsomg/minitandem --commit ${s.nextSha} --json conclusion,status`],'only GitHub was asked, never the server');
    untouched(s);
  }
});

test('ops/deploy.sh refuses a preview with more than 15 % fewer records than the live site, cleans up and restores the checkout',{skip:HAS_TOOLS?false:'bash or git is not installed'},t=>{
  const s=scenario(t,{preview:257});                // 20 % fewer than the 321 that are live
  const result=s.run(s.nextSha);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/257 records is more than 15 % below the 321/);
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
  assert.match(rollback,/ssh -i \S+ -o IdentitiesOnly=yes ubuntu@192\.0\.2\.10 "cd \S+ && git checkout --quiet 'main' && /);
  assert.ok(rollback.includes(`MINITANDEM_TAG=${s.oldTag}/`));assert.match(rollback,/docker compose up -d --no-build/);
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
