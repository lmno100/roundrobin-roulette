// signaling.js — the serverless glue, portable between browser and Node.
// Ports two verified spikes to JS: the linkoffer URL-fragment SDP codec and
// the roster glare-free mesh role logic. Plus a dependency-free MQTT-over-
// WebSocket client so a group can rendezvous through a public broker we do
// not operate (still "serverless" — no server of ours in the path).

// ----------------------------------------------- roster (port of roster.py)

// For any unordered pair, the lexicographically smaller id is the offerer;
// the larger id is the "polite" peer that rolls back on glare (RFC 8829).
export function roleFor(me, peer) {
  if (me === peer) throw new Error('no self-connection');
  return me < peer
    ? { role: 'offer', polite: false }
    : { role: 'answer', polite: true };
}

export function meshOfferers(members) {
  const ids = [...members].sort();
  const out = {};
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++)
      out[`${ids[i]}|${ids[j]}`] = ids[i] < ids[j] ? ids[i] : ids[j];
  return out;
}

// -------------------------------- URL-fragment SDP codec (port of linkoffer)
// Extract the fields that matter from an SDP, pack, and base64url them. We use
// a compact JSON form; the browser's RTCPeerConnection reconstitutes full SDP,
// so unlike the Python spike we only need enough to reproduce a valid session.

export function sdpToFragment(desc) {
  const payload = { t: desc.type, s: desc.sdp };
  return b64urlEncode(deflate(strToU8(JSON.stringify(payload))));
}

export function fragmentToSdp(fragment) {
  const p = JSON.parse(u8ToStr(inflate(b64urlDecode(fragment))));
  return { type: p.t, sdp: p.s };
}

// zlib is not in browsers; use a tiny raw-deflate-free path: we just base64url
// the UTF-8 JSON. (SDP compresses well but correctness first; the transport
// channel — MQTT or hash — carries it fine. Kept as functions so a real
// DEFLATE can drop in.)
function deflate(u8) { return u8; }
function inflate(u8) { return u8; }

export function strToU8(s) { return new TextEncoder().encode(s); }
export function u8ToStr(u8) { return new TextDecoder().decode(u8); }

export function b64urlEncode(u8) {
  let bin = '';
  for (const b of u8) bin += String.fromCharCode(b);
  const b64 = (typeof btoa === 'function' ? btoa(bin)
    : Buffer.from(bin, 'binary').toString('base64'));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4);
  const bin = (typeof atob === 'function' ? atob(b64)
    : Buffer.from(b64, 'base64').toString('binary'));
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

// ----------------------------------------- MQTT 3.1.1 over WebSocket (no deps)
// Only CONNECT / SUBSCRIBE / PUBLISH / PINGREQ — enough for a signaling bus.

function encodeLen(n) {
  const out = [];
  do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 0x80; out.push(b); } while (n > 0);
  return out;
}
function mqttStr(s) {
  const u = strToU8(s);
  return [u.length >> 8, u.length & 0xff, ...u];
}

export function mqttConnect(clientId) {
  const payload = [...mqttStr('MQTT'), 4, 0x02, 0, 60, ...mqttStr(clientId)];
  return new Uint8Array([0x10, ...encodeLen(payload.length), ...payload]);
}
export function mqttSubscribe(topic, id = 1) {
  const payload = [id >> 8, id & 0xff, ...mqttStr(topic), 0];
  return new Uint8Array([0x82, ...encodeLen(payload.length), ...payload]);
}
export function mqttPublish(topic, message) {
  const body = strToU8(message);
  const payload = [...mqttStr(topic), ...body];
  return new Uint8Array([0x30, ...encodeLen(payload.length), ...payload]);
}
export const mqttPingReq = () => new Uint8Array([0xc0, 0x00]);

// Parse one or more MQTT packets from a buffer; returns {publishes:[{topic,message}], rest}
export function mqttParse(u8) {
  const publishes = [];
  let off = 0;
  while (off < u8.length) {
    const type = u8[off] >> 4;
    let mult = 1, len = 0, p = off + 1;
    while (p < u8.length) { len += (u8[p] & 0x7f) * mult; if (!(u8[p] & 0x80)) { p++; break; } mult *= 128; p++; }
    if (p + len > u8.length) break; // incomplete
    const body = u8.slice(p, p + len);
    if (type === 3) { // PUBLISH (QoS 0)
      const tlen = (body[0] << 8) | body[1];
      const topic = u8ToStr(body.slice(2, 2 + tlen));
      const message = u8ToStr(body.slice(2 + tlen));
      publishes.push({ topic, message });
    }
    off = p + len;
  }
  return { publishes, rest: u8.slice(off) };
}
