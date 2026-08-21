# RoundRobin — serverless random roulette ("any bandwidth, anyone, anywhere")

Omegle-style random 1:1 matching built on our serverless-group-chat stack. You're
paired peer-to-peer with a random stranger at a **global connection point** with no
server of ours — signaling rides a public MQTT broker, media is direct P2P and
end-to-end encrypted (SFrame). Per match: **connect** (befriend), **ban** (block),
or **next** (skip).

## Any bandwidth
Requests video+voice; falls back to voice-only; and a **text data channel is always
on**, so anyone connects regardless of connection — with a Video/Voice/Text mode
picker. (Adaptive bitrate is a v2 note.)

## Identity
A real WebCrypto ECDSA keypair in your browser. Your id is the hash of your public
key and you **sign** each lobby presence, so a peer can verify you own your id —
bans and friends can't be trivially spoofed. Identity, bans, and friends persist in
localStorage.

## How matching works (no server decides)
Searching peers broadcast a signed HELLO to a global lobby topic. The smaller-id
peer **claims** a target (MATCH); the target **ACCEPTs**; both leave the lobby into
a private room and connect via perfect negotiation (RFC 8829, reused from the group
chat). Races resolve with reserve + BUSY + timeout-retry. See `matchmaker.js`.

## Files (reuse)
- `signaling.js`, `sframe.js` — reused from serverless-group-chat (roleFor, MQTT
  client, SFrame E2E).
- `identity.js` — crypto identity + ban/friends.
- `matchmaker.js` — distributed claim-based pairing (lobby + rooms).
- `app.js` — orchestration + 1:1 perfect-negotiation connect + any-bandwidth media.
- `index.html` — the product UI.

## Run / test
```
python -m http.server 8140     # or any static server; open http://localhost:8140/
```
Add `?local` and open two tabs to match on one machine (BroadcastChannel instead of
the broker; each tab gets an ephemeral id). `node test.mjs` proves identity +
matchmaking. HTTPS (GitHub Pages) is required for camera on a real device.

## Verified
`node test.mjs`: distinct crypto ids; ECDSA sign/verify + tamper reject; ban+friends
persist; two peers pair into one private room; a banned peer never matches.
