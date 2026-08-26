import { crc32 } from './rwlog.js';

const te = new TextEncoder();
function u16(a,p,v){a[p]=v&255;a[p+1]=(v>>>8)&255;}
function u32(a,p,v){a[p]=v&255;a[p+1]=(v>>>8)&255;a[p+2]=(v>>>16)&255;a[p+3]=(v>>>24)&255;}

async function bytesOf(data){
  if(data instanceof Uint8Array)return data;
  if(data instanceof ArrayBuffer)return new Uint8Array(data);
  if(data instanceof Blob)return new Uint8Array(await data.arrayBuffer());
  return te.encode(String(data));
}
function blobOf(data){
  if(data instanceof Blob)return data;
  if(data instanceof Uint8Array || data instanceof ArrayBuffer)return new Blob([data]);
  return new Blob([String(data)]);
}

async function sha256Hex(blob) {
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function fileSha256(fileOrBlob, maxBytes = 256 * 1024 * 1024) {
  if (!fileOrBlob) return null;
  if (fileOrBlob.size > maxBytes) return { status: 'skipped-large-file', bytes: fileOrBlob.size, sha256: null };
  return { status: 'ok', bytes: fileOrBlob.size, sha256: await sha256Hex(fileOrBlob) };
}

async function makeZip(files){
  const localPieces=[],centrals=[];let offset=0;
  for(const f of files){
    const name=te.encode(f.name),dataBytes=await bytesOf(f.data),dataBlob=blobOf(f.data),size=dataBytes.length,crc=crc32(dataBytes);
    if(size>0xffffffff)throw new Error(`ZIP32 file too large: ${f.name}`);

    const local=new Uint8Array(30+name.length);
    u32(local,0,0x04034b50);u16(local,4,20);u16(local,6,0x0800);u16(local,8,0);u32(local,14,crc);u32(local,18,size);u32(local,22,size);u16(local,26,name.length);local.set(name,30);
    localPieces.push(local,dataBlob);

    const c=new Uint8Array(46+name.length);
    u32(c,0,0x02014b50);u16(c,4,20);u16(c,6,20);u16(c,8,0x0800);u32(c,16,crc);u32(c,20,size);u32(c,24,size);u16(c,28,name.length);u32(c,42,offset);c.set(name,46);centrals.push(c);
    offset+=local.length+size;
  }
  const centralSize=centrals.reduce((s,x)=>s+x.length,0),end=new Uint8Array(22);u32(end,0,0x06054b50);u16(end,8,files.length);u16(end,10,files.length);u32(end,12,centralSize);u32(end,16,offset);
  return new Blob([...localPieces,...centrals,end],{type:'application/zip'});
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function exportSessionZip({ sessionId, videoBlob, videoExtension, angleCsv, rwlogFile, manifest }) {
  const videoName = `${sessionId}_video_raw.${videoExtension}`;
  const angleName = `${sessionId}_angle.csv`;
  const logName = rwlogFile ? `${sessionId}_log.rwlog` : null;
  const manifestName = `${sessionId}_manifest.json`;
  const files=[];
  if(videoBlob)files.push({name:videoName,data:videoBlob});
  files.push({name:angleName,data:angleCsv});
  if(rwlogFile)files.push({name:logName,data:rwlogFile});
  files.push({name:manifestName,data:JSON.stringify(manifest,null,2)});
  const blob=await makeZip(files);downloadBlob(blob,`${sessionId}.zip`);
  return { filename:`${sessionId}.zip`,bytes:blob.size,files:{videoName,angleName,logName,manifestName} };
}
