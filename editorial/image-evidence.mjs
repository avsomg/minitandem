import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {imageSize} from 'image-size';

const runFile=promisify(execFile);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export const IMAGE_BYTES=Symbol('controller image bytes');

export function imageMetadata(bytes,contentType){
  const dimensions=imageSize(bytes),extension=dimensions.type==='jpg'?'jpg':dimensions.type;
  const expected=/^image\/png(?:;|$)/i.test(contentType)?'png':/^image\/jpeg(?:;|$)/i.test(contentType)?'jpg':null;
  if(!expected||extension!==expected)throw Error('Unsupported source image or MIME mismatch');
  const {width,height}=dimensions;
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>10000||height>10000||width*height>25000000)throw Error('Source image exceeds pixel limit');
  return {hash:hash(bytes),extension,width,height,languages:'eng',visualReviewRequired:true};
}

export function validateImage(image,rawHash){
  if(!image||!/^[a-f0-9]{64}$/.test(image.hash)||image.hash!==rawHash||!['png','jpg'].includes(image.extension)||
    !Number.isInteger(image.width)||!Number.isInteger(image.height)||image.width<1||image.height<1||
    image.width>10000||image.height>10000||image.width*image.height>25000000||
    image.languages!=='eng'||image.visualReviewRequired!==true)throw Error('Invalid source image provenance');
  return image;
}

export function imageFile(directory,image){
  validateImage(image,image?.hash);
  return path.join(directory,'images',image.hash+'.'+image.extension);
}

export async function recognizeImage(bytes,contentType,{run=runFile}={}){
  const image=imageMetadata(bytes,contentType),directory=await fs.mkdtemp(path.join(os.tmpdir(),'minitandem-ocr-'));
  try{
    const file=path.join(directory,'source.'+image.extension);await fs.writeFile(file,bytes,{mode:0o600});
    const env=Object.fromEntries(['PATH','TMPDIR','LANG','LC_ALL'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
    const {stdout}=await run('tesseract',[file,'stdout','-l','eng','--psm','3'],
      {timeout:20000,maxBuffer:2000000,env:{...env,OMP_THREAD_LIMIT:'1'}});
    return {image,text:stdout.trim()};
  }finally{await fs.rm(directory,{recursive:true,force:true});}
}

export async function saveImage(directory,evidence){
  const image=validateImage(evidence.image,evidence.rawHash),file=imageFile(directory,image),bytes=evidence[IMAGE_BYTES];
  await fs.mkdir(path.dirname(file),{recursive:true});
  if(bytes){
    if(hash(bytes)!==image.hash)throw Error('Source image bytes changed');
    try{await fs.writeFile(file,bytes,{flag:'wx',mode:0o600});}
    catch(error){if(error.code!=='EEXIST')throw error;}
  }
  if((await fs.lstat(file)).isSymbolicLink())throw Error('Symlink in source image evidence');
  if(hash(await fs.readFile(file))!==image.hash)throw Error('Stored source image hash mismatch');
  return file;
}
