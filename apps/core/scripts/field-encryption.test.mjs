import test from 'node:test';
import assert from 'node:assert/strict';
import {supportsNativeFieldEncryption, parseEncryptedText, encodeEncryptedText, textFieldAad, nativeFileAad, MAX_TEXT_PLAINTEXT_BYTES} from '../src/field-encryption.ts';
const nonce = Uint8Array.from({length:12}, (_,i)=>i);
const ciphertext = new Uint8Array(16);
const envelope = {keyVersion:1,nonce,ciphertext};
const wire = 'lsenc1.1.AAECAwQFBgcICQoL.AAAAAAAAAAAAAAAAAAAAAA';
const space = 'spc_'+'a'.repeat(32), record = 'rec_'+'b'.repeat(32), file = 'fil_'+'c'.repeat(32);

test('Native encryption type allowlist is exact',()=>{
  for(const type of ['string','text','file','file_list']) assert.equal(supportsNativeFieldEncryption(type),true);
  for(const type of ['file_ref_list','integer','number','boolean','date','instant','enum','enum_list','record','record_list','person','location',null,{},'String']) assert.equal(supportsNativeFieldEncryption(type),false);
});
test('canonical text envelope round-trips, including empty plaintext tag',()=>{
  assert.equal(encodeEncryptedText(envelope),wire);
  assert.deepEqual(parseEncryptedText(wire),envelope);
  assert.equal(encodeEncryptedText(parseEncryptedText(wire)),wire);
});
test('reject plaintext, malformed, padded, noncanonical, invalid version and oversized input',()=>{
  for(const x of [null,{},'plaintext',wire+'\n',wire+'=',wire+'.',wire.replace('lsenc1','lsenc2'),wire.replace('.1.','.01.'),wire.replace('.1.','.0.'),wire.replace('.1.','.4294967296.'),wire.replace('.1.','.1\n.'),wire.replace('AAECAwQFBgcICQoL','AAECAwQFBgcICQo'),wire.slice(0,-1),wire.slice(0,-1)+'B',wire+'A'.repeat(MAX_TEXT_PLAINTEXT_BYTES*2)]) assert.equal(parseEncryptedText(x),null,JSON.stringify(typeof x==='string'?x.slice(0,80):x));
  assert.throws(()=>encodeEncryptedText({...envelope,keyVersion:0}),TypeError);
  assert.throws(()=>encodeEncryptedText({...envelope,nonce:new Uint8Array(11)}),TypeError);
  assert.throws(()=>encodeEncryptedText({...envelope,ciphertext:new Uint8Array(15)}),TypeError);
});
test('wire size limit accounts for tag and base64 expansion',()=>{
  const max={...envelope,ciphertext:new Uint8Array(MAX_TEXT_PLAINTEXT_BYTES+16)};
  assert.deepEqual(parseEncryptedText(encodeEncryptedText(max)),max);
  assert.throws(()=>encodeEncryptedText({...max,ciphertext:new Uint8Array(MAX_TEXT_PLAINTEXT_BYTES+17)}),TypeError);
});
test('AAD binds record, field, model, source Space and key version and separates File domain',()=>{
  const base=textFieldAad(space,'test_model',record,'secret',1);
  assert.equal(new TextDecoder().decode(base),JSON.stringify(['LifeSpace','field',1,1,space,'test_model',record,'secret']));
  for(const alt of [textFieldAad('spc_'+'d'.repeat(32),'test_model',record,'secret',1),textFieldAad(space,'other_model',record,'secret',1),textFieldAad(space,'test_model','rec_'+'e'.repeat(32),'secret',1),textFieldAad(space,'test_model',record,'other',1),textFieldAad(space,'test_model',record,'secret',2),nativeFileAad(space,file,1)]) assert.notDeepEqual(base,alt);
  assert.throws(()=>textFieldAad(space,'test_model',record+'\n','secret',1),TypeError);
  assert.throws(()=>nativeFileAad(space,record,1),TypeError);
});
test('real Web Crypto authentication rejects transplant to a different record',async()=>{
  const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const aad=textFieldAad(space,'test_model',record,'secret',1);
  const plaintext=new TextEncoder().encode('敏感内容');
  const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad},key,plaintext));
  const parsed=parseEncryptedText(encodeEncryptedText({keyVersion:1,nonce:iv,ciphertext:encrypted}));
  assert.deepEqual(new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:parsed.nonce,additionalData:aad},key,parsed.ciphertext)),plaintext);
  await assert.rejects(crypto.subtle.decrypt({name:'AES-GCM',iv:parsed.nonce,additionalData:textFieldAad(space,'test_model','rec_'+'d'.repeat(32),'secret',1)},key,parsed.ciphertext));
});
