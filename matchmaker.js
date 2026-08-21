// matchmaker.js — distributed, serverless roulette pairing.
// A global lobby over the public MQTT broker (or BroadcastChannel in ?local mode).
// Searching peers broadcast signed HELLO; the smaller-id peer claims a target with
// MATCH, the target ACCEPTs, both leave the lobby into a private room. No server
// arbitrates — claim + reserve + timeout handles races.

import { mqttConnect, mqttSubscribe, mqttPublish, mqttParse, mqttPingReq } from "./signaling.js";
import { Identity } from "./identity.js";

const BROKER = "wss://broker.emqx.io:8084/mqtt";
export const LOBBY = "rfccypher/roulette/lobby";

export function makeBus(topic, clientId, useLocal) {
  const handlers = [];
  if (useLocal) {
    const ch = new BroadcastChannel("rlt-" + topic);
    ch.onmessage = e => handlers.forEach(h => h(e.data));
    return { ready: Promise.resolve(), on: h => handlers.push(h),
             send: m => ch.postMessage(m), close: () => ch.close() };
  }
  const ws = new WebSocket(BROKER, "mqtt"); ws.binaryType = "arraybuffer";
  let buf = new Uint8Array(0);
  const ready = new Promise(resolve => {
    ws.onopen = () => ws.send(mqttConnect(clientId + "-" + Math.random().toString(36).slice(2, 7)));
    ws.onmessage = e => {
      const chunk = new Uint8Array(e.data);
      const cat = new Uint8Array(buf.length + chunk.length); cat.set(buf); cat.set(chunk, buf.length);
      if (cat[0] >> 4 === 2) { ws.send(mqttSubscribe(topic)); resolve(); buf = cat.slice(4); return; }
      const { publishes, rest } = mqttParse(cat); buf = rest;
      for (const p of publishes) { try { handlers.forEach(h => h(JSON.parse(p.message))); } catch {} }
    };
  });
  const ping = setInterval(() => ws.readyState === 1 && ws.send(mqttPingReq()), 30000);
  return { ready, on: h => handlers.push(h),
           send: m => ws.readyState === 1 && ws.send(mqttPublish(topic, JSON.stringify(m))),
           close: () => { clearInterval(ping); try { ws.close(); } catch {} } };
}

export class Matchmaker {
  constructor(identity, { useLocal = false, onMatch, onState } = {}) {
    this.id = identity; this.useLocal = useLocal;
    this.onMatch = onMatch; this.onState = onState || (() => {});
    this.state = "idle";
    this.pool = new Map();      // id -> {handle, pubkey, lastSeen}
    this.reservedWith = null;   // id we're mid-claim with
    this.lobby = null;
  }

  _set(s) { this.state = s; this.onState(s, this.pool); }

  async search() {
    if (this.lobby) this.lobby.close();
    this.pool.clear(); this.reservedWith = null;
    this.lobby = makeBus(LOBBY, this.id.id, this.useLocal);
    await this.lobby.ready;
    this.lobby.on(m => this._onLobby(m));
    this._set("searching");
    this._hello();
    this._helloTimer = setInterval(() => this._hello(), 2000);
    this._matchTimer = setInterval(() => this._tryClaim(), 1500);
  }

  stop() {
    clearInterval(this._helloTimer); clearInterval(this._matchTimer);
    if (this.lobby) { this.lobby.send({ t: "bye", from: this.id.id }); this.lobby.close(); this.lobby = null; }
    this._set("idle");
  }

  async _hello() {
    if (this.state !== "searching") return;
    const nonce = Math.random().toString(36).slice(2);
    const sig = await this.id.sign(this.id.id + nonce);
    const p = this.id.profile ? this.id.profile() : {};
    this.lobby.send({ t: "hello", from: this.id.id, handle: this.id.handle,
                      pubkey: this.id.pubB64(), nonce, sig, ts: Date.now(),
                      gender: p.gender || "", prefer: p.prefer || "everyone",
                      interests: p.interests || [], country: p.country || "" });
  }

  // mutual compatibility: I accept their gender AND they accept mine
  _eligible(p) {
    const myG = this.id.getGender ? this.id.getGender() : "";
    const myP = this.id.getPrefer ? this.id.getPrefer() : "everyone";
    const iWant = myP === "everyone" || (!!p.gender && myP === p.gender);
    const theyWant = (p.prefer || "everyone") === "everyone" || (!!myG && p.prefer === myG);
    return iWant && theyWant;
  }

  async _onLobby(m) {
    if (m.from === this.id.id) return;
    if (this.id.isBanned(m.from)) return;
    if (m.t === "hello") {
      // verify the sender owns their id
      if (!await Identity.verify(m.pubkey, m.from + m.nonce, m.sig)) return;
      this.pool.set(m.from, { handle: m.handle, pubkey: m.pubkey, lastSeen: Date.now(),
                              gender: m.gender || "", prefer: m.prefer || "everyone",
                              interests: m.interests || [], country: m.country || "" });
      this.onState(this.state, this.pool);
    } else if (m.t === "bye") {
      this.pool.delete(m.from);
    } else if (m.t === "match" && m.to === this.id.id) {
      // someone claims us — enforce our filter too (two-sided)
      const claimer = this.pool.get(m.from);
      if (claimer && !this._eligible(claimer)) { this.lobby.send({ t: "busy", from: this.id.id, to: m.from }); return; }
      if (this.state === "searching" && !this.reservedWith) {
        this.reservedWith = m.from;
        this.lobby.send({ t: "accept", from: this.id.id, to: m.from, room: m.room });
        this._enterRoom(m.room, m.from, this.pool.get(m.from));
      } else {
        this.lobby.send({ t: "busy", from: this.id.id, to: m.from });
      }
    } else if (m.t === "accept" && m.to === this.id.id) {
      if (this.reservedWith === m.from) this._enterRoom(m.room, m.from, this.pool.get(m.from));
    } else if (m.t === "busy" && m.to === this.id.id) {
      if (this.reservedWith === m.from) { this.reservedWith = null; }  // retry next tick
    }
  }

  _tryClaim() {
    if (this.state !== "searching" || this.reservedWith) return;
    const now = Date.now();
    // prune stale
    for (const [id, v] of this.pool) if (now - v.lastSeen > 6000) this.pool.delete(id);
    // smaller-id initiates (one claimer per pair); only to mutually-eligible peers;
    // bias toward shared interests
    const myInts = new Set(this.id.getInterests ? this.id.getInterests() : []);
    let targets = [...this.pool.entries()]
      .filter(([id, p]) => this.id.id < id && this._eligible(p))
      .map(([id, p]) => ({ id, shared: (p.interests || []).filter(x => myInts.has(x)).length }));
    if (!targets.length) return;
    const maxShared = Math.max(...targets.map(t => t.shared));
    if (maxShared > 0) targets = targets.filter(t => t.shared === maxShared);  // prefer best-matched
    const target = targets[Math.floor(Math.random() * targets.length)].id;
    const room = "r" + Math.random().toString(36).slice(2, 10);
    this.reservedWith = target;
    this.lobby.send({ t: "match", from: this.id.id, to: target, room });
    // release the claim if not accepted shortly
    setTimeout(() => { if (this.state === "searching" && this.reservedWith === target) this.reservedWith = null; }, 2500);
  }

  _enterRoom(room, peerId, peerEntry) {
    clearInterval(this._helloTimer); clearInterval(this._matchTimer);
    if (this.lobby) { this.lobby.close(); this.lobby = null; }
    this._set("matched");
    const roomBus = makeBus("rfccypher/roulette/room/" + room, this.id.id, this.useLocal);
    const p = peerEntry || {};
    this.onMatch({ room, roomBus, peerId, peerHandle: p.handle || peerId,
                   peerProfile: { gender: p.gender || "", interests: p.interests || [], country: p.country || "" } });
  }
}
