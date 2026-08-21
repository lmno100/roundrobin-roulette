// identity.js — a real, persistent, spoof-resistant identity.
// An ECDSA P-256 keypair (WebCrypto) stored in localStorage as JWK. Your id is a
// short hash of the public key; you sign each lobby presence so a peer can verify
// you own the id (ban/friend by id can't be trivially forged). Ban + friends lists
// also persist here.

const LS = {
  priv: "rlt_priv", pub: "rlt_pub", handle: "rlt_handle",
  bans: "rlt_bans", friends: "rlt_friends",
  gender: "rlt_gender", prefer: "rlt_prefer", interests: "rlt_interests", country: "rlt_country",
};

export function flagEmoji(code) {
  if (!code || code.length !== 2) return "🏳️";
  return String.fromCodePoint(...[...code.toUpperCase()].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
}

const HANDLES_A = ["swift","calm","lucky","bright","brave","quiet","wild","noble","keen","warm","odd","true","neon","lone","fair"];
const HANDLES_B = ["otter","falcon","koala","raven","tiger","gecko","moth","bison","lynx","crane","fox","wolf","seal","hare","owl"];

function b64u(bytes) {
  let s = ""; for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64u(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - s.length % 4) % 4);
  const bin = atob(s), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

export class Identity {
  constructor() { this.priv = null; this.pub = null; this.pubRaw = null; this.id = null; this.handle = null; }

  async init() {
    let privJwk = localStorage.getItem(LS.priv);
    let pubJwk = localStorage.getItem(LS.pub);
    if (privJwk && pubJwk) {
      this.priv = await crypto.subtle.importKey("jwk", JSON.parse(privJwk),
        { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
      this.pub = await crypto.subtle.importKey("jwk", JSON.parse(pubJwk),
        { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
    } else {
      const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
      this.priv = kp.privateKey; this.pub = kp.publicKey;
      localStorage.setItem(LS.priv, JSON.stringify(await crypto.subtle.exportKey("jwk", kp.privateKey)));
      localStorage.setItem(LS.pub, JSON.stringify(await crypto.subtle.exportKey("jwk", kp.publicKey)));
    }
    this.pubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", this.pub));
    const digest = await crypto.subtle.digest("SHA-256", this.pubRaw);
    this.id = b64u(digest).slice(0, 16);
    this.handle = localStorage.getItem(LS.handle) || this._genHandle();
    return this;
  }

  _genHandle() {
    const n = parseInt(this.id.slice(0, 4), 36) || 0;
    const h = `${HANDLES_A[n % HANDLES_A.length]}-${HANDLES_B[(n >> 3) % HANDLES_B.length]}`;
    localStorage.setItem(LS.handle, h);
    return h;
  }
  setHandle(h) { this.handle = h.slice(0, 24); localStorage.setItem(LS.handle, this.handle); }

  pubB64() { return b64u(this.pubRaw); }

  async sign(str) {
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.priv,
      new TextEncoder().encode(str));
    return b64u(sig);
  }

  static async verify(pubB64, str, sigB64) {
    try {
      const pub = await crypto.subtle.importKey("raw", fromB64u(pubB64),
        { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub,
        fromB64u(sigB64), new TextEncoder().encode(str));
    } catch { return false; }
  }

  // ban list
  bans() { return new Set(JSON.parse(localStorage.getItem(LS.bans) || "[]")); }
  ban(id) { const s = this.bans(); s.add(id); localStorage.setItem(LS.bans, JSON.stringify([...s])); }
  isBanned(id) { return this.bans().has(id); }

  // ---- profile (self-declared): gender, who they'll chat with, interests, country
  getGender() { return localStorage.getItem(LS.gender) || ""; }              // male|female|other|""
  setGender(g) { localStorage.setItem(LS.gender, g); this.gender = g; }
  getPrefer() { return localStorage.getItem(LS.prefer) || "everyone"; }      // everyone|male|female
  setPrefer(p) { localStorage.setItem(LS.prefer, p); this.prefer = p; }
  getInterests() { try { return JSON.parse(localStorage.getItem(LS.interests) || "[]"); } catch { return []; } }
  setInterests(arr) {
    const clean = [...new Set(arr.map(s => s.trim().toLowerCase()).filter(Boolean))].slice(0, 8);
    localStorage.setItem(LS.interests, JSON.stringify(clean)); this.interests = clean; return clean;
  }
  async detectCountry() {
    const cached = (() => { try { return JSON.parse(localStorage.getItem(LS.country) || "null"); } catch { return null; } })();
    if (cached && Date.now() - cached.at < 86400000) { this.countryCache = cached; return cached; }
    let c = { code: (navigator.language.split("-")[1] || "").toUpperCase(), name: "", at: Date.now() };
    try {
      const r = await fetch("https://ipwho.is/?fields=country_code,country");
      const j = await r.json();
      if (j && j.country_code) c = { code: j.country_code, name: j.country || "", at: Date.now() };
    } catch {}
    localStorage.setItem(LS.country, JSON.stringify(c));
    this.countryCache = c;
    return c;
  }
  profile() {
    return { gender: this.getGender(), prefer: this.getPrefer(),
             interests: this.getInterests(), country: (this.countryCache || {}).code || "" };
  }

  // friends list  [{id, handle, at}]
  friends() { return JSON.parse(localStorage.getItem(LS.friends) || "[]"); }
  addFriend(id, handle) {
    const f = this.friends().filter(x => x.id !== id);
    f.unshift({ id, handle, at: Date.now() });
    localStorage.setItem(LS.friends, JSON.stringify(f.slice(0, 100)));
  }
  isFriend(id) { return this.friends().some(x => x.id === id); }
}
