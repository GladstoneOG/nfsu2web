import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";

export const VIRTUAL_MASK = "255.255.128.0";
export const ROAM_HUB_VIP = 0x0a4d00fd; // 10.77.0.253
export const BROADCAST_VIP = 0xffffffff;

const NETS = 96;
const HOSTS_PER_NET = 250; // host bytes 2..251
const TOTAL_ADDRS = NETS * HOSTS_PER_NET;
const RESERVE_MS = 60_000;
const HUB_SENDER_ID = 0x48554201;

const KIND_UDP = 1;
const KIND_LAN_UDP = 3;
const KIND_LAN_TCP = 4;
const KIND_LAN_ICMP = 5;
const KIND_BUNDLE = 32;
const KIND_COMPACT = 33;
const BUNDLE_STAMPED = 0x01;
const UDP_PORTS_SET = 0x80000000;

const N2FR_MAGIC = 0x4e324652; // "N2FR"
const MSG_HELLO = 1;
const MSG_PEERS = 2;
const MSG_SNAP = 3;
const MSG_BYE = 8;
const MSG_MAPREQ = 10;
const MSG_MAPD = 17;
const MSG_NEARREQ = 18;
const MSG_NEARD = 19;
const HF_CREW = 0x0200;

const TRACK_KEYS = [4711, 4701, 4311, 4301, 4201, 4211, 4221, 4601, 4605];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array, len: number): number {
  let c = 0xffffffff;
  for (let i = 0; i < len; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export function vipAt(index: number): number {
  const net = index % NETS;
  const host = 2 + Math.floor(index / NETS);
  return ((10 << 24) | (77 << 16) | (net << 8) | host) >>> 0;
}

export function ipStr(v: number): string {
  return `${v >>> 24}.${(v >>> 16) & 255}.${(v >>> 8) & 255}.${v & 255}`;
}

export function parseSwitchVip(s: unknown): number {
  if (typeof s === "number" && Number.isInteger(s) && s > 0) return s >>> 0;
  if (typeof s !== "string") return 0;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s.trim());
  if (!m) return 0;
  const b = m.slice(1).map(Number);
  if (b.some((x) => x > 255)) return 0;
  if (b[0] !== 10 || b[1] !== 77 || b[2] >= NETS || b[3] < 2 || b[3] > 251) return 0;
  return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
}

export function cleanDisplayName(raw: unknown): string {
  const s = typeof raw === "string" ? raw : String(raw ?? "");
  const nfc = s.normalize("NFC");
  let out = "";
  let inSpace = false;
  for (const ch of nfc) {
    const cp = ch.codePointAt(0)!;
    // Strip Cc (control) and common Cf (format: bidi, zero-width, BOM)
    if (
      cp <= 0x1f ||
      (cp >= 0x7f && cp <= 0x9f) ||
      cp === 0x00ad ||
      cp === 0x061c ||
      cp === 0x180e ||
      (cp >= 0x200b && cp <= 0x200f) ||
      (cp >= 0x202a && cp <= 0x202e) ||
      (cp >= 0x2060 && cp <= 0x206f) ||
      cp === 0xfeff ||
      (cp >= 0xe0000 && cp <= 0xe007f)
    ) {
      continue;
    }
    if (/\s/.test(ch)) {
      if (!inSpace && out.length > 0) {
        out += " ";
        inSpace = true;
      }
    } else {
      out += ch;
      inSpace = false;
    }
  }
  const trimmed = out.trim();
  const capped = Array.from(trimmed).slice(0, 32).join("").trim();
  return capped || "player";
}

function trackRoom(base: number, key: number): number {
  const r = (base ^ Math.imul(key, 0x9e3779b1)) >>> 0;
  return r === 0 ? 1 : r;
}

function worldCount(counts: Map<number, number>, room: number): number {
  let total = counts.get(room) ?? 0;
  for (const k of TRACK_KEYS) {
    total += counts.get(trackRoom(room, k)) ?? 0;
  }
  return total;
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  const b = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, "0");
  return out;
}

function randomToken(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let bin = "";
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface RoamState {
  id: number;
  port: number;
  hubPort: number;
  status: number;
  room: number;
  core: number;
  crews: number[];
  x?: number;
  y?: number;
  z?: number;
  lastPeersAt: number;
}

export interface PeerAttachment {
  vip: number;
  vipStr: string;
  name: string;
  tokenHash: string;
  hello: boolean;
  lan: boolean;
  udp: number;
  bundle: boolean;
  roam?: RoamState;
}

function defaultAttachment(): PeerAttachment {
  return {
    vip: 0,
    vipStr: "",
    name: "player",
    tokenHash: "",
    hello: false,
    lan: false,
    udp: 0,
    bundle: true,
  };
}

export class RoomSwitchDO extends DurableObject<Env> {
  private sqlReady = false;
  private nextAlloc = 0;
  private hubSeq = 1;
  private byVip: Map<number, WebSocket> | null = null;
  private attachments = new WeakMap<WebSocket, PeerAttachment>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  private ensureSql(): void {
    if (this.sqlReady) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS reservations (
        vip INTEGER PRIMARY KEY,
        token_hash TEXT NOT NULL,
        until INTEGER NOT NULL
      );
    `);
    this.sqlReady = true;
  }

  private getByVip(): Map<number, WebSocket> {
    if (this.byVip) return this.byVip;
    const map = new Map<number, WebSocket>();
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.getAtt(ws);
      if (att.vip > 0) {
        map.set(att.vip, ws);
      }
    }
    this.byVip = map;
    return map;
  }

  private getAtt(ws: WebSocket): PeerAttachment {
    let att = this.attachments.get(ws);
    if (!att) {
      const raw = ws.deserializeAttachment() as PeerAttachment | null;
      att = raw ?? defaultAttachment();
      this.attachments.set(ws, att);
    }
    return att;
  }

  private saveAtt(ws: WebSocket, att: PeerAttachment): void {
    this.attachments.set(ws, att);
    ws.serializeAttachment(att);
  }

  private maxPeers(): number {
    const n = Number(this.env.MAX_PEERS ?? "32");
    return Number.isFinite(n) && n > 0 ? Math.min(TOTAL_ADDRS, Math.floor(n)) : 32;
  }

  private expireReservations(now: number): void {
    this.ensureSql();
    this.ctx.storage.sql.exec("DELETE FROM reservations WHERE until <= ?", now);
  }

  private activeReservationVips(now: number): Set<number> {
    this.ensureSql();
    this.expireReservations(now);
    const rows = this.ctx.storage.sql.exec<{ vip: number }>("SELECT vip FROM reservations").toArray();
    return new Set(rows.map((r) => r.vip >>> 0));
  }

  private allocateVip(now: number): number {
    const byVip = this.getByVip();
    const reserved = this.activeReservationVips(now);
    for (let i = 0; i < TOTAL_ADDRS; i++) {
      const idx = (this.nextAlloc + i) % TOTAL_ADDRS;
      const candidate = vipAt(idx);
      if (!byVip.has(candidate) && !reserved.has(candidate)) {
        this.nextAlloc = (idx + 1) % TOTAL_ADDRS;
        return candidate;
      }
    }
    return 0;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      this.saveAtt(server, defaultAttachment());
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/internal/players") {
      return this.handlePlayers(url);
    }

    return new Response("Not found", { status: 404 });
  }

  private handlePlayers(url: URL): Response {
    const byVip = this.getByVip();
    const players = byVip.size;
    const roomCounts = new Map<number, number>();
    const crewCounts = new Map<number, number>();
    let roamCount = 0;

    for (const ws of byVip.values()) {
      const att = this.getAtt(ws);
      if (att.roam && (att.roam.status === 2 || att.roam.status === 5)) {
        roamCount++;
        roomCounts.set(att.roam.room, (roomCounts.get(att.roam.room) ?? 0) + 1);
        for (const c of att.roam.crews) {
          if (c !== 0) {
            crewCounts.set(c, (crewCounts.get(c) ?? 0) + 1);
          }
        }
      }
    }

    const now = Date.now();
    const reservedCount = this.activeReservationVips(now).size;
    const maxP = this.maxPeers();

    const out: Record<string, unknown> = {
      players,
      online: null,
      roam: roamCount,
      full: players + reservedCount >= maxP,
      queue: 0,
      roamBusy: false,
    };

    const roomParam = url.searchParams.get("room");
    if (roomParam) {
      const rh = Number(roomParam);
      if (Number.isInteger(rh) && rh > 0) {
        out.room = Math.min(players, worldCount(roomCounts, rh >>> 0));
      }
    }

    const roomsParam = url.searchParams.get("rooms");
    if (roomsParam) {
      const asked = roomsParam
        .split(",")
        .map((x) => Number(x))
        .filter((x) => Number.isInteger(x) && x >= 0)
        .slice(0, 8);
      if (asked.length > 0) {
        out.rooms = asked.map((h) => Math.min(players, worldCount(roomCounts, h >>> 0)));
      }
    }

    const spotsParam = url.searchParams.get("spots");
    if (spotsParam) {
      const asked = spotsParam
        .split(",")
        .map((x) => Number(x))
        .filter((x) => Number.isInteger(x) && x >= 0)
        .slice(0, 16);
      if (asked.length > 0) {
        out.spots = asked.map((h) => Math.min(players, roomCounts.get(h >>> 0) ?? 0));
      }
    }

    const crewsParam = url.searchParams.get("crews");
    if (crewsParam) {
      const asked = crewsParam
        .split(",")
        .map((x) => Number(x))
        .filter((x) => Number.isInteger(x) && x > 0)
        .slice(0, 4);
      if (asked.length > 0) {
        out.crews = asked.map((h) => Math.min(players, crewCounts.get(h >>> 0) ?? 0));
      }
    }

    return new Response(JSON.stringify(out), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === "string") {
      let parsed: Record<string, unknown>;
      try {
        const v = JSON.parse(message);
        if (!v || typeof v !== "object" || Array.isArray(v)) return;
        parsed = v as Record<string, unknown>;
      } catch {
        return;
      }
      await this.handleControl(ws, parsed);
      return;
    }

    const bytes = new Uint8Array(message);
    const att = this.getAtt(ws);
    if (att.vip === 0 || bytes.byteLength < 12) return;

    if (bytes[0] === KIND_BUNDLE) {
      this.handleBundle(ws, att, bytes);
    } else if (bytes[0] !== KIND_COMPACT) {
      const dst = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, false);
      this.routeFrame(ws, att, bytes, dst);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.cleanupPeer(ws, code, reason);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.cleanupPeer(ws, 1006, "");
  }

  private cleanupPeer(ws: WebSocket, code: number, reason: string): void {
    const att = this.getAtt(ws);
    const vip = att.vip;
    if (vip === 0) return;

    const byVip = this.getByVip();
    if (byVip.get(vip) !== ws) return;

    byVip.delete(vip);
    const hadRoom = att.roam?.room;
    att.vip = 0;
    this.saveAtt(ws, att);

    const letGo = code === 1000 && (reason === "idle" || reason === "closed" || reason === "replaced");
    if (!letGo && att.tokenHash) {
      this.ensureSql();
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO reservations (vip, token_hash, until) VALUES (?, ?, ?)",
        vip,
        att.tokenHash,
        Date.now() + RESERVE_MS
      );
    }

    this.broadcastDelta([], [vip]);
    if (hadRoom !== undefined) {
      this.broadcastRoamPeers(hadRoom);
    }
  }

  private async handleControl(ws: WebSocket, msg: Record<string, unknown>): Promise<void> {
    const t = msg.t;
    if (typeof t !== "string") return;

    const att = this.getAtt(ws);

    if (t === "ping") {
      if (typeof msg.id === "number" && Number.isSafeInteger(msg.id)) {
        this.sendJson(ws, { t: "pong", id: msg.id });
      }
      return;
    }

    if (t === "hello") {
      if (att.hello) return; // only first hello configures the peer

      const now = Date.now();
      const byVip = this.getByVip();
      const name = cleanDisplayName(msg.name);
      const lanOn = msg.lan === 1;
      const udp = typeof msg.udp === "number" && (msg.udp & UDP_PORTS_SET) !== 0 ? msg.udp >>> 0 : 0;
      const bundle = msg.bundle === undefined ? true : msg.bundle === 1;

      let assignedVip = 0;
      let replacedWs: WebSocket | null = null;
      const reqVip = parseSwitchVip(msg.vip);
      const reqTok = typeof msg.token === "string" && msg.token.length <= 64 ? msg.token : "";

      if (reqVip > 0 && reqTok) {
        const reqHash = await sha256Hex(reqTok);
        const currentHolder = byVip.get(reqVip);
        if (currentHolder) {
          const holderAtt = this.getAtt(currentHolder);
          if (holderAtt.tokenHash === reqHash) {
            assignedVip = reqVip;
            replacedWs = currentHolder;
          }
        } else {
          this.ensureSql();
          this.expireReservations(now);
          const res = this.ctx.storage.sql
            .exec<{ token_hash: string }>("SELECT token_hash FROM reservations WHERE vip = ?", reqVip)
            .toArray()[0];
          if (res && res.token_hash === reqHash) {
            this.ctx.storage.sql.exec("DELETE FROM reservations WHERE vip = ?", reqVip);
            assignedVip = reqVip;
          }
        }
      }

      if (assignedVip === 0) {
        const reservedCount = this.activeReservationVips(now).size;
        if (byVip.size + reservedCount >= this.maxPeers()) {
          try {
            ws.close(1013, "LAN full");
          } catch {
            // ignore
          }
          return;
        }
        assignedVip = this.allocateVip(now);
        if (assignedVip === 0) {
          try {
            ws.close(1013, "LAN full");
          } catch {
            // ignore
          }
          return;
        }
      }

      if (replacedWs && replacedWs !== ws) {
        const oldAtt = this.getAtt(replacedWs);
        oldAtt.vip = 0;
        this.saveAtt(replacedWs, oldAtt);
        byVip.delete(assignedVip);
        try {
          replacedWs.close(1000, "replaced");
        } catch {
          // ignore
        }
      }

      const newTok = randomToken();
      const newHash = await sha256Hex(newTok);
      const vipStr = ipStr(assignedVip);

      const nextAtt: PeerAttachment = {
        vip: assignedVip,
        vipStr,
        name,
        tokenHash: newHash,
        hello: true,
        lan: lanOn,
        udp,
        bundle,
      };
      byVip.set(assignedVip, ws);
      this.saveAtt(ws, nextAtt);

      this.sendJson(ws, {
        t: "welcome",
        vip: assignedVip,
        vipStr,
        mask: VIRTUAL_MASK,
        token: newTok,
        bundle: 1,
      });

      this.sendPeerList(ws, nextAtt);
      this.broadcastDelta([{ vip: assignedVip, name }], [], assignedVip);
      return;
    }

    if (att.vip === 0) return;

    if (t === "lan") {
      const wasLan = att.lan;
      att.lan = msg.on === 1;
      att.udp = typeof msg.udp === "number" && (msg.udp & UDP_PORTS_SET) !== 0 ? msg.udp >>> 0 : 0;
      this.saveAtt(ws, att);
      if (att.lan && !wasLan) {
        this.sendPeerList(ws, att);
      }
      return;
    }

    if (t === "rename") {
      const nextName = cleanDisplayName(msg.name);
      if (nextName !== att.name) {
        att.name = nextName;
        this.saveAtt(ws, att);
        this.broadcastDelta([{ vip: att.vip, name: nextName }], [], att.vip);
      }
      return;
    }

    if (t === "rtc-offer" || t === "rtc-answer" || t === "rtc-ice") {
      const toVip = parseSwitchVip(msg.to);
      if (toVip === 0 || toVip === att.vip) return;
      const target = this.getByVip().get(toVip);
      if (!target) return;
      this.sendJson(target, {
        t,
        from: att.vip,
        data: msg.data ?? null,
      });
    }
  }

  private sendJson(ws: WebSocket, payload: unknown): void {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // socket closing
    }
  }

  private sendPeerList(ws: WebSocket, att: PeerAttachment): void {
    if (!att.lan) {
      this.sendJson(ws, { t: "peers", peers: [] });
      return;
    }
    const peers: { vip: number; name: string }[] = [];
    for (const peerWs of this.getByVip().values()) {
      const pa = this.getAtt(peerWs);
      if (pa.vip > 0 && pa.hello) {
        peers.push({ vip: pa.vip, name: pa.name });
      }
    }
    this.sendJson(ws, { t: "peers", peers });
  }

  private broadcastDelta(
    peers: { vip: number; name: string }[],
    gone: number[],
    excludeVip?: number
  ): void {
    if (peers.length === 0 && gone.length === 0) return;
    const msg = JSON.stringify({ t: "delta", peers, gone });
    for (const peerWs of this.getByVip().values()) {
      const pa = this.getAtt(peerWs);
      if (pa.lan && pa.vip > 0 && pa.vip !== excludeVip) {
        try {
          peerWs.send(msg);
        } catch {
          // ignore
        }
      }
    }
  }

  private handleBundle(ws: WebSocket, att: PeerAttachment, data: Uint8Array): void {
    const n = data.byteLength;
    let at = data[1] & BUNDLE_STAMPED ? 16 : 4;
    while (at + 4 <= n) {
      const k = data[at];
      const len = (data[at + 2] << 8) | data[at + 3];
      const f = at + 4 + 4 * k;
      const end = f + len;
      if (len < 12 || end > n || data[f] === KIND_BUNDLE || data[f] === KIND_COMPACT) {
        return;
      }
      const frame = data.subarray(f, end);
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      if (k === 0) {
        const dst = dv.getUint32(f + 8, false);
        this.routeFrame(ws, att, frame, dst);
      } else {
        for (let j = 0; j < k; j++) {
          const dst = dv.getUint32(at + 4 + 4 * j, false);
          this.routeFrame(ws, att, frame, dst);
        }
      }
      at = end;
    }
  }

  private routeFrame(ws: WebSocket, att: PeerAttachment, rawFrame: Uint8Array, dst: number): void {
    const kind = rawFrame[0];
    if (kind !== KIND_UDP && kind !== KIND_LAN_UDP && kind !== KIND_LAN_TCP && kind !== KIND_LAN_ICMP) {
      return;
    }

    // Copy so we safely rewrite source/dest VIPs without mutating a shared bundle slice
    const frame = new Uint8Array(rawFrame);
    const dv = new DataView(frame.buffer);
    dv.setUint32(4, att.vip, false);
    dv.setUint32(8, dst, false);

    if (dst === ROAM_HUB_VIP && kind === KIND_UDP) {
      this.handleRoamHubFrame(ws, att, frame);
      return;
    }

    const byVip = this.getByVip();
    const lanOnly = kind >= KIND_LAN_UDP && kind <= KIND_LAN_ICMP;

    if (dst === BROADCAST_VIP) {
      const dport = kind === KIND_LAN_UDP && frame.byteLength >= 16 ? dv.getUint16(14, false) : 0;
      for (const [peerVip, peerWs] of byVip) {
        if (peerVip === att.vip) continue;
        const pa = this.getAtt(peerWs);
        if (!pa.hello) continue;
        if (lanOnly && !pa.lan) continue;
        if (dport > 0 && (pa.udp & UDP_PORTS_SET) !== 0 && (pa.udp & (1 << (dport % 31))) === 0) {
          continue;
        }
        try {
          peerWs.send(frame);
        } catch {
          // ignore
        }
      }
      return;
    }

    const targetWs = byVip.get(dst >>> 0);
    if (!targetWs) return;
    try {
      targetWs.send(frame);
    } catch {
      // ignore
    }
  }

  // ---- Embedded Free-Roam Hub (10.77.0.253) ----

  private handleRoamHubFrame(ws: WebSocket, att: PeerAttachment, frame: Uint8Array): void {
    if (frame.byteLength < 16 + 20) return;
    const fdv = new DataView(frame.buffer);
    const sport = fdv.getUint16(12, false);
    const dport = fdv.getUint16(14, false);
    const d = frame.subarray(16);
    const dlen = d.byteLength;
    if (dlen < 20 || dlen > 1200) return;

    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    if (dv.getUint32(0, false) !== N2FR_MAGIC || d[4] !== 1) return;
    if (dv.getUint16(6, true) !== dlen) return;
    const end = dlen - 4;
    if (crc32(d, end) !== dv.getUint32(end, true)) return;

    const msgType = d[5];
    const senderId = dv.getUint32(8, true);
    if (senderId === 0) return;

    if (msgType === MSG_HELLO) {
      if (end < 29) return;
      const flags = dv.getUint16(14, true);
      const core = dv.getUint16(16, true);
      const status = d[19];
      const room = dv.getUint32(24, true);
      const nl = d[28];
      if (nl > 24 || end < 29 + nl + 1 || status > 5) return;

      const crews: number[] = [];
      if (flags & HF_CREW) {
        const seen = d[29 + nl];
        const at = 29 + nl + 1 + 4 * seen;
        if (seen <= 64 && at < end) {
          const nc = d[at];
          if (nc <= 4 && at + 1 + 4 * nc <= end) {
            for (let k = 0; k < nc; k++) {
              const c = dv.getUint32(at + 1 + 4 * k, true);
              if (c !== 0) crews.push(c);
            }
          }
        }
      }

      const prev = att.roam;
      const changed =
        !prev ||
        prev.id !== senderId ||
        prev.port !== sport ||
        prev.room !== room;
      const oldRoom = prev?.room;

      const now = Date.now();
      att.roam = {
        id: senderId,
        port: sport,
        hubPort: dport,
        status,
        room,
        core,
        crews,
        x: prev?.x,
        y: prev?.y,
        z: prev?.z,
        lastPeersAt: prev?.lastPeersAt ?? 0,
      };
      this.saveAtt(ws, att);

      if (changed) {
        this.broadcastRoamPeers(room);
        if (oldRoom !== undefined && oldRoom !== room) {
          this.broadcastRoamPeers(oldRoom);
        }
      } else if (now - att.roam.lastPeersAt >= 1000) {
        this.sendRoamPeersTo(ws, att);
      }
      return;
    }

    if (msgType === MSG_SNAP) {
      if (!att.roam || att.roam.id !== senderId || end < 22 + 52) return;
      const status = d[16];
      const nStates = d[20];
      if (nStates < 1 || nStates > 3 || status > 5 || end !== 22 + 52 * nStates) return;
      const x = dv.getFloat32(26, true);
      const y = dv.getFloat32(30, true);
      const z = dv.getFloat32(34, true);
      const statusChanged = att.roam.status !== status;
      att.roam.status = status;
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
        att.roam.x = x;
        att.roam.y = y;
        att.roam.z = z;
      }
      if (statusChanged) {
        this.saveAtt(ws, att);
      }
      return;
    }

    if (msgType === MSG_BYE) {
      const oldRoom = att.roam?.room;
      if (att.roam) {
        delete att.roam;
        this.saveAtt(ws, att);
        if (oldRoom !== undefined) {
          this.broadcastRoamPeers(oldRoom);
        }
      }
      return;
    }

    if (msgType === MSG_MAPREQ && (end === 22 || end === 24)) {
      if (!att.roam || att.roam.id !== senderId) return;
      const req = dv.getUint16(16, true);
      const base = dv.getUint16(20, true);
      this.sendEmptyMapDelta(ws, att, MSG_MAPD, req, base);
      return;
    }

    if (msgType === MSG_NEARREQ && end === 24) {
      if (!att.roam || att.roam.id !== senderId) return;
      const req = dv.getUint16(16, true);
      const base = dv.getUint16(20, true);
      this.sendEmptyMapDelta(ws, att, MSG_NEARD, req, base);
    }
  }

  private broadcastRoamPeers(room: number): void {
    const members: { ws: WebSocket; att: PeerAttachment }[] = [];
    for (const ws of this.getByVip().values()) {
      const att = this.getAtt(ws);
      if (att.vip > 0 && att.roam && att.roam.room === room) {
        members.push({ ws, att });
      }
    }
    const now = Date.now();
    for (const m of members) {
      this.sendRoamPeersWithList(m.ws, m.att, members, now);
    }
  }

  private sendRoamPeersTo(ws: WebSocket, att: PeerAttachment): void {
    if (!att.roam) return;
    const room = att.roam.room;
    const members: { ws: WebSocket; att: PeerAttachment }[] = [];
    for (const peerWs of this.getByVip().values()) {
      const pa = this.getAtt(peerWs);
      if (pa.vip > 0 && pa.roam && pa.roam.room === room) {
        members.push({ ws: peerWs, att: pa });
      }
    }
    this.sendRoamPeersWithList(ws, att, members, Date.now());
  }

  private sendRoamPeersWithList(
    ws: WebSocket,
    att: PeerAttachment,
    members: { ws: WebSocket; att: PeerAttachment }[],
    now: number
  ): void {
    const roam = att.roam;
    if (!roam) return;

    const maxEntries = roam.core >= 14 ? 64 : roam.core >= 10 ? 48 : 32;
    const list: { vip: number; port: number; id: number }[] = [];
    for (const m of members) {
      if (m.att.vip === att.vip) continue;
      if (!m.att.roam) continue;
      list.push({ vip: m.att.vip, port: m.att.roam.port, id: m.att.roam.id });
      if (list.length >= maxEntries) break;
    }

    const innerLen = 16 + 1 + 10 * list.length + 4;
    const frame = new Uint8Array(16 + innerLen);
    const fdv = new DataView(frame.buffer);
    frame[0] = KIND_UDP;
    fdv.setUint32(4, ROAM_HUB_VIP, false);
    fdv.setUint32(8, att.vip, false);
    fdv.setUint16(12, roam.hubPort, false);
    fdv.setUint16(14, roam.port, false);

    const p = frame.subarray(16);
    const pdv = new DataView(p.buffer, p.byteOffset, p.byteLength);
    pdv.setUint32(0, N2FR_MAGIC, false);
    p[4] = 1;
    p[5] = MSG_PEERS;
    pdv.setUint16(6, innerLen, true);
    pdv.setUint32(8, HUB_SENDER_ID, true);
    pdv.setUint16(12, this.hubSeq++ & 0xffff, true);
    pdv.setUint16(14, 0, true);
    p[16] = list.length;

    for (let i = 0; i < list.length; i++) {
      const o = 17 + 10 * i;
      pdv.setUint32(o, list[i].vip, false); // BE vip (wire.rs write_peers)
      pdv.setUint16(o + 4, list[i].port, true); // LE port
      pdv.setUint32(o + 6, list[i].id, true); // LE id
    }
    pdv.setUint32(innerLen - 4, crc32(p, innerLen - 4), true);

    roam.lastPeersAt = now;
    try {
      ws.send(frame);
    } catch {
      // ignore
    }
  }

  private sendEmptyMapDelta(
    ws: WebSocket,
    att: PeerAttachment,
    msgType: number,
    req: number,
    base: number
  ): void {
    const roam = att.roam;
    if (!roam) return;
    const innerLen = 16 + 9 + 4;
    const frame = new Uint8Array(16 + innerLen);
    const fdv = new DataView(frame.buffer);
    frame[0] = KIND_UDP;
    fdv.setUint32(4, ROAM_HUB_VIP, false);
    fdv.setUint32(8, att.vip, false);
    fdv.setUint16(12, roam.hubPort, false);
    fdv.setUint16(14, roam.port, false);

    const p = frame.subarray(16);
    const pdv = new DataView(p.buffer, p.byteOffset, p.byteLength);
    pdv.setUint32(0, N2FR_MAGIC, false);
    p[4] = 1;
    p[5] = msgType;
    pdv.setUint16(6, innerLen, true);
    pdv.setUint32(8, HUB_SENDER_ID, true);
    pdv.setUint16(12, this.hubSeq++ & 0xffff, true);
    pdv.setUint16(14, 0, true);
    pdv.setUint16(16, req, true);
    pdv.setUint16(18, base, true);
    p[20] = 0; // part
    p[21] = 1; // nparts
    pdv.setUint16(22, 0, true); // total
    p[24] = 0; // n entries
    pdv.setUint32(innerLen - 4, crc32(p, innerLen - 4), true);

    try {
      ws.send(frame);
    } catch {
      // ignore
    }
  }
}
