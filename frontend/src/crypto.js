// frontend/src/crypto.js

export async function encryptMessage(text, aesKey) {
  const enc = new TextEncoder();
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const ciphertextBuffer = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, aesKey, enc.encode(text)
  );
  const ciphertextArray = new Uint8Array(ciphertextBuffer);
  const combined = new Uint8Array(iv.length + ciphertextArray.length);
  combined.set(iv, 0);
  combined.set(ciphertextArray, iv.length);
  return arrayBufferToBase64(combined.buffer);
}

export async function decryptMessage(base64Payload, aesKey) {
  const combinedBuffer = base64ToArrayBuffer(base64Payload);
  const combinedArray = new Uint8Array(combinedBuffer);
  const iv = combinedArray.slice(0, 12);
  const ciphertext = combinedArray.slice(12);
  try {
    const decryptedBuffer = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv }, aesKey, ciphertext
    );
    const dec = new TextDecoder();
    return dec.decode(decryptedBuffer);
  } catch (error) {
    throw new Error("Decryption failed. Incorrect key?");
  }
}

export async function generateIdentityKeyPair() {
  return await window.crypto.subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["encrypt", "decrypt"]
  );
}

export async function exportPublicKey(keyPair) {
  const exported = await window.crypto.subtle.exportKey("jwk", keyPair.publicKey);
  return JSON.stringify(exported);
}

export async function importPublicKey(jwkString) {
  const jwk = JSON.parse(jwkString);
  return await window.crypto.subtle.importKey(
    "jwk", jwk, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]
  );
}

export async function importPrivateKey(jwkString) {
  const jwk = JSON.parse(jwkString);
  return await window.crypto.subtle.importKey(
    "jwk", jwk, { name: "RSA-OAEP", hash: "SHA-256" }, true, ["decrypt"]
  );
}

async function deriveWrappingKey(password, saltString) {
  const enc = new TextEncoder();
  const passwordKey = await window.crypto.subtle.importKey('raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveKey']);
  const saltHash = await window.crypto.subtle.digest('SHA-256', enc.encode(saltString));
  return await window.crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltHash, iterations: 100000, hash: 'SHA-256' }, passwordKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

export async function wrapPrivateKey(privateKey, loginPassword, usernameSalt) {
  const jwk = await window.crypto.subtle.exportKey("jwk", privateKey);
  const wrappingKey = await deriveWrappingKey(loginPassword, usernameSalt);
  return await encryptMessage(JSON.stringify(jwk), wrappingKey);
}

export async function unwrapPrivateKey(wrappedBase64, loginPassword, usernameSalt) {
  const wrappingKey = await deriveWrappingKey(loginPassword, usernameSalt);
  const jwkString = await decryptMessage(wrappedBase64, wrappingKey);
  const jwk = JSON.parse(jwkString);
  return await window.crypto.subtle.importKey(
    "jwk", jwk, { name: "RSA-OAEP", hash: "SHA-256" }, true, ["decrypt"]
  );
}

export async function generateRoomKey() {
  return await window.crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]
  );
}

export async function encryptRoomKeyWithPublicKey(aesKey, publicKeyJWKString) {
  const publicKey = await importPublicKey(publicKeyJWKString);
  const rawAesKey = await window.crypto.subtle.exportKey("raw", aesKey);
  const encryptedRoomKeyBuffer = await window.crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, rawAesKey);
  return arrayBufferToBase64(encryptedRoomKeyBuffer);
}

export async function decryptRoomKeyWithPrivateKey(encryptedRoomKeyBase64, privateKey) {
  const encryptedBuffer = base64ToArrayBuffer(encryptedRoomKeyBase64);
  const rawAesKey = await window.crypto.subtle.decrypt({ name: "RSA-OAEP" }, privateKey, encryptedBuffer);
  return await window.crypto.subtle.importKey("raw", rawAesKey, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return window.btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary_string = window.atob(base64);
  const len = binary_string.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary_string.charCodeAt(i);
  return bytes.buffer;
}
