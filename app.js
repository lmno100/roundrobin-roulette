// app.js — roulette orchestration. Identity → lobby search → match → 1:1 WebRTC
// (perfect negotiation, lifted from serverless-group-chat) with any-bandwidth media
// fallback and E2E sframe. Controls: NEXT / CONNECT / BAN / STOP.
import { roleFor } from "./signaling.js";
import { deriveKey, SFrame, installSenderTransform, installReceiverTransform } from "./sframe.js";
import { Identity } from "./identity.js";
import { Matchmaker } from "./matchmaker.js";

const RTC = { encodedInsertableStreams: true, iceServers: [
  { urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }] };

const $ = id => document.getElementById(id);
const useLocal = new URLSearchParams(location.search).has("local");

let ident, mm, localStream, sframeKey;
let conn = null;   // { pc, dc, bus, peerId, peerHandle, verified }
let mediaMode = "video";  // video | audio | text
let running = false;

function setStatus(t, cls) { const s = $("status"); s.textContent = t; s.className = "status " + (cls || ""); }

async function boot() {
  ident = await new Identity().init();
  if (useLocal) {  // two tabs share localStorage → give each a distinct ephemeral id
    ident.id = ident.id.slice(0, 6) + "-" + Math.random().toString(36).slice(2, 6);
    ident.handle = ident.handle + "-" + ident.id.slice(-3);
  }
  $("me").textContent = ident.handle;
  $("meId").textContent = ident.id.slice(0, 8);
  $("handleIn").value = ident.handle;
  sframeKey = await deriveKey("roulette-global-v1");   // shared room key; per-pair rekey is v2
  renderFriends();
  setStatus(useLocal ? "ready (local test mode)" : "ready", "");
}

function gumTimeout(constraints, ms) {
  // never let a hung/slow permission prompt block the whole flow — race a timeout
  return Promise.race([
    navigator.mediaDevices.getUserMedia(constraints),
    new Promise((_, rej) => setTimeout(() => rej(new Error("media-timeout")), ms)),
  ]);
}
async function acquireMedia() {
  const tries = mediaMode === "text" ? [] :
    mediaMode === "audio" ? [{ audio: true }] :
    [{ video: true, audio: true }, { audio: true }];
  for (const c of tries) {
    try { return await gumTimeout(c, 12000); } catch {}
  }
  return new MediaStream();  // text/data-only floor — any-bandwidth never stalls
}

async function start() {
  if (running) return; running = true;
  localStream = await acquireMedia();
  $("meVid").srcObject = localStream;
  $("modeTag").textContent = localStream.getTracks().map(t => t.kind).join("+") || "text-only";
  mm = new Matchmaker(ident, { useLocal, onMatch: onMatch, onState: onState });
  await mm.search();
  setStatus("searching for a stranger…", "searching");
}

function onState(state, pool) {
  if (state === "searching") $("poolCount").textContent = pool.size;
}

async function onMatch({ roomBus, peerId, peerHandle }) {
  await roomBus.ready;
  conn = { pc: null, dc: null, bus: roomBus, peerId, peerHandle, verified: false };
  setStatus(`matched with ${peerHandle}`, "matched");
  roomBus.on(m => onSignal(m));
  ensurePeer();
  roomBus.send({ from: ident.id, hello: true, handle: ident.handle, pub: ident.pubB64() });
  wireControls();
}

function onSignal(m) {
  if (!conn || m.from === ident.id) return;
  if (m.bye) { remoteGone(); return; }
  if (m.hello) {
    conn.peerHandle = m.handle || conn.peerHandle;
    if (m.pub) verifyPeer(m.pub, m.from);
    ensurePeer();
    if (!m.ack) conn.bus.send({ from: ident.id, hello: true, ack: true, handle: ident.handle, pub: ident.pubB64() });
    return;
  }
  if (m.description) handleDescription(m.description);
  else if (m.candidate) conn.pc && conn.pc.addIceCandidate(m.candidate).catch(() => {});
}

async function verifyPeer(pub, id) {
  // the peer's id must be the hash of the pubkey it presents (prevents id spoofing)
  const raw = Uint8Array.from(atob(pub.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  const digest = await crypto.subtle.digest("SHA-256", raw);
  let s = ""; for (const b of new Uint8Array(digest)) s += String.fromCharCode(b);
  const hash = btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 16);
  conn.verified = (hash === id);
  $("peerBadge").textContent = conn.verified ? "✓ verified id" : "⚠ unverified";
  $("peerBadge").className = "badge " + (conn.verified ? "ok" : "warn");
}

function ensurePeer() {
  if (conn.pc) return conn.pc;
  const pc = new RTCPeerConnection(RTC);
  conn.pc = pc; conn.makingOffer = false; conn.polite = roleFor(ident.id, conn.peerId).polite;
  for (const track of localStream.getTracks()) {
    const sender = pc.addTrack(track, localStream);
    installSenderTransform(sender, new SFrame(1, sframeKey));
  }
  pc.ontrack = e => { installReceiverTransform(e.receiver, new SFrame(1, sframeKey)); $("peerVid").srcObject = e.streams[0]; };
  pc.onicecandidate = e => { if (e.candidate) conn.bus.send({ from: ident.id, candidate: e.candidate.toJSON() }); };
  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    if (st === "connected") { setStatus(`connected with ${conn.peerHandle}`, "connected"); $("peerName").textContent = conn.peerHandle; }
    if (st === "failed") pc.restartIce();
    if (st === "disconnected" || st === "closed") { }
  };
  pc.onnegotiationneeded = async () => {
    try { conn.makingOffer = true; await pc.setLocalDescription();
      conn.bus.send({ from: ident.id, description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
    } finally { conn.makingOffer = false; }
  };
  if (roleFor(ident.id, conn.peerId).role === "offer") { const dc = pc.createDataChannel("chat"); wireChannel(dc); conn.dc = dc; }
  else pc.ondatachannel = e => { wireChannel(e.channel); conn.dc = e.channel; };
  return pc;
}

async function handleDescription(desc) {
  const pc = ensurePeer();
  const collision = desc.type === "offer" && (conn.makingOffer || pc.signalingState !== "stable");
  if (collision && !conn.polite) return;
  if (collision) await pc.setLocalDescription({ type: "rollback" }).catch(() => {});
  await pc.setRemoteDescription(desc);
  if (desc.type === "offer") { await pc.setLocalDescription();
    conn.bus.send({ from: ident.id, description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } }); }
}

function wireChannel(dc) {
  dc.onopen = () => { $("chatBox").hidden = false; addChat("system", "text channel open — say hi"); };
  dc.onmessage = e => addChat(conn.peerHandle, e.data);
}
function addChat(who, text) { const c = $("chatLog"); const d = document.createElement("div");
  d.className = "line" + (who === "system" ? " sys" : who === "you" ? " you" : "");
  d.textContent = (who === "system" ? "" : who + ": ") + text; c.append(d); c.scrollTop = c.scrollHeight; }

// ---- controls
function wireControls() { $("controls").hidden = false; }
function teardown(sendBye = true) {
  if (!conn) return;
  if (sendBye && conn.bus) conn.bus.send({ from: ident.id, bye: true });
  if (conn.pc) try { conn.pc.close(); } catch {}
  if (conn.bus) conn.bus.close();
  $("peerVid").srcObject = null; $("peerName").textContent = "—"; $("peerBadge").textContent = "";
  $("chatLog").innerHTML = ""; $("chatBox").hidden = true; $("controls").hidden = true;
  conn = null;
}
function remoteGone() { addChat("system", "stranger left"); next(); }

async function next() { teardown(true); if (running) { setStatus("searching for a stranger…", "searching"); await mm.search(); } }
function connectFriend() { if (!conn) return; ident.addFriend(conn.peerId, conn.peerHandle);
  renderFriends(); addChat("system", `added ${conn.peerHandle} to friends`); }
function ban() { if (!conn) return; ident.ban(conn.peerId); addChat("system", `banned ${conn.peerHandle}`); next(); }
function stop() { running = false; teardown(true); if (mm) mm.stop();
  (localStream ? localStream.getTracks() : []).forEach(t => t.stop());
  $("meVid").srcObject = null; setStatus("stopped", ""); }

function renderFriends() {
  const f = ident.friends();
  $("friendCount").textContent = f.length;
  $("friendList").innerHTML = f.map(x => `<li>${x.handle} <span class="fid">${x.id.slice(0,6)}</span></li>`).join("") || "<li class='empty'>no friends yet</li>";
}

// ---- UI wiring
window.addEventListener("DOMContentLoaded", async () => {
  await boot();
  $("startBtn").onclick = () => { $("startBtn").disabled = true; $("stopBtn").hidden = false; start(); };
  $("stopBtn").onclick = () => { stop(); $("startBtn").disabled = false; $("stopBtn").hidden = true; };
  $("nextBtn").onclick = () => next();
  $("connectBtn").onclick = () => connectFriend();
  $("banBtn").onclick = () => ban();
  $("saveHandle").onclick = () => { ident.setHandle($("handleIn").value.trim() || ident.handle); $("me").textContent = ident.handle; };
  $("modeSel").onchange = e => { mediaMode = e.target.value; };
  $("chatIn").addEventListener("keydown", e => { if (e.key === "Enter") sendChat(); });
  $("chatSend").onclick = sendChat;
  $("friendsToggle").onclick = () => $("friendsDrawer").classList.toggle("open");
});
function sendChat() { const t = $("chatIn").value.trim(); if (!t || !conn?.dc || conn.dc.readyState !== "open") return;
  addChat("you", t); conn.dc.send(t); $("chatIn").value = ""; }
window.addEventListener("beforeunload", () => { if (conn?.bus) conn.bus.send({ from: ident.id, bye: true }); });
