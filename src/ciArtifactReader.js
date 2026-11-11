'use strict';
// Read-only, bounded ZIP verifier for a single GitHub Actions diagnostic.json.
const {createHash,timingSafeEqual}=require('node:crypto');
const {inflateRawSync}=require('node:zlib');
const {TextDecoder}=require('node:util');
const MAX_ZIP=65536,MAX_JSON=4096;
const blocked=reason=>Object.freeze({status:'blocked',reason,mayEditDraft:false,mayMerge:false,mayDeploy:false});
const utf8=new TextDecoder('utf-8',{fatal:true});
function rejectDuplicateKeys(text) {
  // Tokenize JSON strings and structural punctuation; track keys at every object depth.
  let i=0;
  function ws(){while(/[\x20\t\r\n]/.test(text[i]||'!'))i++;}
  function str(){const start=i++;let esc=false;while(i<text.length){const c=text[i++];if(!esc&&c==='"')return JSON.parse(text.slice(start,i));if(!esc&&c==='\\')esc=true;else esc=false;}throw Error('unterminated');}
  function value(){ws();const c=text[i];if(c==='"'){str();return;}if(c==='{'){i++;const keys=new Set();ws();if(text[i]==='}'){i++;return;}while(true){ws();if(text[i]!=='"')throw Error('key');const k=str();if(keys.has(k))throw Error('duplicate');keys.add(k);ws();if(text[i++]!==':')throw Error('colon');value();ws();const d=text[i++];if(d==='}')return;if(d!==',')throw Error('comma');}}if(c==='['){i++;ws();if(text[i]===']'){i++;return;}while(true){value();ws();const d=text[i++];if(d===']')return;if(d!==',')throw Error('comma');}}const m=/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));if(!m)throw Error('value');i+=m[0].length;}
  value();ws();if(i!==text.length)throw Error('trailing');
}
function extractDiagnostic(zip) {
  if(!Buffer.isBuffer(zip)||zip.length<22||zip.length>MAX_ZIP)throw Error('zip_size');
  let end=-1;for(let i=zip.length-22;i>=Math.max(0,zip.length-65557);i--)if(zip.readUInt32LE(i)===0x06054b50&&i+22+zip.readUInt16LE(i+20)===zip.length){end=i;break;}
  if(end<0||zip.readUInt16LE(end+4)!==0||zip.readUInt16LE(end+6)!==0||zip.readUInt16LE(end+8)!==1||zip.readUInt16LE(end+10)!==1)throw Error('zip_entries');
  const size=zip.readUInt32LE(end+12),offset=zip.readUInt32LE(end+16);
  if(offset+size>end||size<46||zip.readUInt32LE(offset)!==0x02014b50)throw Error('zip_central');
  const flags=zip.readUInt16LE(offset+8),method=zip.readUInt16LE(offset+10),crc=zip.readUInt32LE(offset+16),compressed=zip.readUInt32LE(offset+20),uncompressed=zip.readUInt32LE(offset+24),nameLen=zip.readUInt16LE(offset+28),extraLen=zip.readUInt16LE(offset+30),commentLen=zip.readUInt16LE(offset+32),local=zip.readUInt32LE(offset+42);
  if(![0,0x800,0x8,0x808].includes(flags)||![0,8].includes(method)||uncompressed>MAX_JSON||compressed>MAX_ZIP||offset+46+nameLen+extraLen+commentLen!==offset+size)throw Error('zip_metadata');
  const name=utf8.decode(zip.subarray(offset+46,offset+46+nameLen));
  if(name!=='diagnostic.json'||name.includes('/')||name.includes('\\'))throw Error('zip_path');
  if(local+30>offset||zip.readUInt32LE(local)!==0x04034b50||zip.readUInt16LE(local+6)!==flags||zip.readUInt16LE(local+8)!==method)throw Error('zip_local');
  // In descriptor mode, CRC and sizes are carried after compressed bytes.
  // Without bit 3, local header values must exactly match the central directory.
  if(!(flags&0x8)&&(zip.readUInt32LE(local+14)!==crc||
      zip.readUInt32LE(local+18)!==compressed||
      zip.readUInt32LE(local+22)!==uncompressed))throw Error('zip_local_metadata');
  if(flags&0x8) {
    for(const pos of [local+14,local+18,local+22])
      if(zip.readUInt32LE(pos)!==0)throw Error('zip_local_descriptor_placeholder');
  }
  const ln=zip.readUInt16LE(local+26),le=zip.readUInt16LE(local+28);
  if(utf8.decode(zip.subarray(local+30,local+30+ln))!==name)throw Error('zip_name_mismatch');
  const start=local+30+ln+le;
  const dataEnd=start+compressed;
  if(dataEnd>offset)throw Error('zip_overlap');
  if(flags&0x8){
    const remaining=offset-dataEnd;
    const hasSignature=remaining===16;
    if(remaining!==12&&!hasSignature)throw Error('zip_descriptor_length');
    const at=dataEnd+(hasSignature?4:0);
    if(hasSignature&&zip.readUInt32LE(dataEnd)!==0x08074b50)throw Error('zip_descriptor_signature');
    if(zip.readUInt32LE(at)!==crc||
       zip.readUInt32LE(at+4)!==compressed||
       zip.readUInt32LE(at+8)!==uncompressed)throw Error('zip_descriptor_mismatch');
  }else if(dataEnd!==offset)throw Error('zip_trailing_data');
  const payload=zip.subarray(start,start+compressed);
  const out=method===0?payload:inflateRawSync(payload,{maxOutputLength:MAX_JSON+1});
  if(out.length!==uncompressed||out.length>MAX_JSON)throw Error('zip_length');
  let crcValue=0xffffffff;for(const b of out){crcValue^=b;for(let j=0;j<8;j++)crcValue=(crcValue>>>1)^((crcValue&1)?0xedb88320:0);}
  if(((crcValue^0xffffffff)>>>0)!==crc)throw Error('zip_crc');
  const json=utf8.decode(out);rejectDuplicateKeys(json);JSON.parse(json);
  return json;
}
function verifyCiArtifactZip({zipBytes,artifact}={}){
  if(!Buffer.isBuffer(zipBytes)||zipBytes.length>MAX_ZIP||!artifact||typeof artifact.digest!=='string'||!/^sha256:[a-f0-9]{64}$/i.test(artifact.digest))return blocked('artifact_bytes_or_digest_invalid');
  const actual=createHash('sha256').update(zipBytes).digest();
  const expected=Buffer.from(artifact.digest.slice(7),'hex');
  if(!timingSafeEqual(actual,expected))return blocked('artifact_digest_mismatch');
  try{return Object.freeze({status:'ok',diagnosticJson:extractDiagnostic(zipBytes)});}
  catch{return blocked('artifact_zip_invalid');}
}
module.exports={verifyCiArtifactZip};
