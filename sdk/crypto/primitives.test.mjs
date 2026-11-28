import test from 'node:test';
import assert from 'node:assert/strict';
import {generateDekBytes, importAes256Key, encryptBytes, decryptBytes, wrapDek, unwrapDek} from './primitives.mjs';

const utf8 = value => new TextEncoder().encode(value);
const hex = value => Uint8Array.from(Buffer.from(value, 'hex'));
const aad = utf8('lifespace-test:space-a:field-a');
const other = utf8('lifespace-test:space-b:field-a');

test('AES-256-GCM independent interoperability vector', async () => {
  const key = await importAes256Key(hex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'));
  const result = await decryptBytes(key, {
    nonce: hex('000102030405060708090a0b'),
    ciphertext: hex('0b6bb07e9695a378e861e3eec29d0369479ef2faddfe346c03669661c2d4'),
  }, aad);
  assert.deepEqual(result, utf8('LifeSpace test'));
});

test('text, binary and empty payload round-trip; distinct nonces', async () => {
  const raw = generateDekBytes();
  const key = await importAes256Key(raw);
  raw.fill(0);
  assert.equal(key.extractable, false);
  for (const data of [utf8('证件号码'), Uint8Array.of(0, 255, 32, 128), new Uint8Array()]) {
    const a = await encryptBytes(key, data, aad);
    const b = await encryptBytes(key, data, aad);
    assert.equal(a.nonce.length, 12);
    assert.equal(a.ciphertext.length, data.length + 16);
    assert.notDeepEqual(a.nonce, b.nonce);
    assert.deepEqual(await decryptBytes(key, a, aad), data);
    assert.deepEqual(await decryptBytes(key, b, aad), data);
  }
});

test('wrong context, wrong key, altered nonce and ciphertext all fail closed', async () => {
  const key = await importAes256Key(generateDekBytes());
  const wrongKey = await importAes256Key(generateDekBytes());
  const env = await encryptBytes(key, utf8('secret'), aad);
  await assert.rejects(decryptBytes(key, env, other));
  await assert.rejects(decryptBytes(wrongKey, env, aad));
  const nonce = env.nonce.slice(); nonce[0] ^= 1;
  await assert.rejects(decryptBytes(key, {...env, nonce}, aad));
  const ciphertext = env.ciphertext.slice(); ciphertext[0] ^= 1;
  await assert.rejects(decryptBytes(key, {...env, ciphertext}, aad));
});

test('DEK wrapping and rewrapping preserve data key and reject old KEK', async () => {
  const oldKek = await importAes256Key(generateDekBytes());
  const newKek = await importAes256Key(generateDekBytes());
  const raw = generateDekBytes();
  const wrapContext = utf8('lifespace-test:wrap:space-a');
  const old = await wrapDek(oldKek, raw, wrapContext);
  assert.equal(old.ciphertext.length, 48);
  const temp = await unwrapDek(oldKek, old, wrapContext);
  try {
    assert.deepEqual(temp, raw);
    const next = await wrapDek(newKek, temp, wrapContext);
    const recovered = await unwrapDek(newKek, next, wrapContext);
    try {
      assert.deepEqual(recovered, raw);
      const dataKey = await importAes256Key(recovered);
      const env = await encryptBytes(dataKey, utf8('same DEK'), aad);
      assert.deepEqual(await decryptBytes(await importAes256Key(raw), env, aad), utf8('same DEK'));
    } finally { recovered.fill(0); }
    await assert.rejects(unwrapDek(oldKek, next, wrapContext));
    await assert.rejects(unwrapDek(newKek, next, other));
  } finally { temp.fill(0); raw.fill(0); }
});

test('invalid input sizes, empty AAD and wrong algorithms are rejected', async () => {
  await assert.rejects(importAes256Key(new Uint8Array(31)), TypeError);
  const key = await importAes256Key(generateDekBytes());
  await assert.rejects(encryptBytes(key, utf8('x'), new Uint8Array()), TypeError);
  await assert.rejects(encryptBytes(key, 'x', aad), TypeError);
  await assert.rejects(decryptBytes(key, {nonce: new Uint8Array(11), ciphertext: new Uint8Array(16)}, aad), TypeError);
  await assert.rejects(decryptBytes(key, {nonce: new Uint8Array(12), ciphertext: new Uint8Array(15)}, aad), TypeError);
  await assert.rejects(wrapDek(key, new Uint8Array(31), aad), TypeError);
  await assert.rejects(unwrapDek(key, {nonce: new Uint8Array(12), ciphertext: new Uint8Array(47)}, aad), TypeError);
  const wrong = await crypto.subtle.generateKey({name: 'AES-GCM', length: 128}, false, ['encrypt', 'decrypt']);
  await assert.rejects(encryptBytes(wrong, utf8('x'), aad), TypeError);
});
