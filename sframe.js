// sframe.js — end-to-end media encryption for the mesh, real AES-GCM this time.
// The Python spike used an HMAC keystream because stdlib lacks AES; browsers
// (and Node) have SubtleCrypto, so here SFrame (RFC 9605) uses proper AES-GCM.
// The header codec (KID/CTR length nibbles) matches the Python spike exactly.

export function encodeHeader(kid, ctr) {
  const klen = byteLen(kid), clen = byteLen(ctr);
  const cfg = ((klen - 1) << 4) | (clen - 1);
  const out = [cfg];
  for (let i = klen - 1; i >= 0; i--) out.push((kid >> (8 * i)) & 0xff);
  for (let i = clen - 1; i >= 0; i--) out.push((ctr >> (8 * i)) & 0xff);
  return new Uint8Array(out);
}

export function decodeHeader(u8) {
  const cfg = u8[0];
  const klen = (cfg >> 4) + 1, clen = (cfg & 0x0f) + 1;
  let kid = 0, ctr = 0, p = 1;
  for (let i = 0; i < klen; i++) kid = (kid << 8) | u8[p++];
  for (let i = 0; i < clen; i++) ctr = (ctr << 8) | u8[p++];
  return { kid, ctr, headerLen: p };
}

function byteLen(n) { return Math.max(1, Math.ceil((n === 0 ? 1 : Math.log2(n + 1)) / 8)); }

// Derive a 128-bit AES-GCM key for (roomSecret) so everyone in the room shares
// it but nothing outside can read the media.
export async function deriveKey(roomSecret) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(roomSecret),
    'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: new TextEncoder().encode('sframe-media') },
    base, { name: 'AES-GCM', length: 128 }, false, ['encrypt', 'decrypt']);
}

export class SFrame {
  constructor(kid, key) { this.kid = kid; this.key = key; this.ctr = 0; }

  async protect(plaintext) {
    const ctr = this.ctr++;
    const header = encodeHeader(this.kid, ctr);
    const iv = new Uint8Array(12);
    header.forEach((b, i) => { iv[i] = b; });          // header seeds the nonce
    const ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: header }, this.key, plaintext));
    const out = new Uint8Array(header.length + ct.length);
    out.set(header); out.set(ct, header.length);
    return out;
  }

  async unprotect(frame) {
    const { kid, headerLen } = decodeHeader(frame);
    if (kid !== this.kid && this.kid !== -1) throw new Error('wrong key id');
    const header = frame.slice(0, headerLen);
    const iv = new Uint8Array(12);
    header.forEach((b, i) => { iv[i] = b; });
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: header }, this.key, frame.slice(headerLen));
    return new Uint8Array(pt);
  }
}

// Insertable-streams transforms wired onto an RTCRtpSender/Receiver.
export function installSenderTransform(sender, sframe) {
  if (!sender.createEncodedStreams) return false;
  const { readable, writable } = sender.createEncodedStreams();
  readable.pipeThrough(new TransformStream({
    async transform(chunk, controller) {
      chunk.data = (await sframe.protect(new Uint8Array(chunk.data))).buffer;
      controller.enqueue(chunk);
    },
  })).pipeTo(writable);
  return true;
}

export function installReceiverTransform(receiver, sframe) {
  if (!receiver.createEncodedStreams) return false;
  const { readable, writable } = receiver.createEncodedStreams();
  readable.pipeThrough(new TransformStream({
    async transform(chunk, controller) {
      try {
        chunk.data = (await sframe.unprotect(new Uint8Array(chunk.data))).buffer;
        controller.enqueue(chunk);
      } catch { /* drop undecryptable frame */ }
    },
  })).pipeTo(writable);
  return true;
}
