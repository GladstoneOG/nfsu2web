// Opportunistic WebRTC P2P DataChannel mesh for Cloudflare Free-Tier multiplayer.
//
// Car snapshots (KIND_UDP) and LAN race datagrams (KIND_LAN_UDP) travel directly
// peer-to-peer over unordered, unreliable DataChannels (`ordered: false,
// maxRetransmits: 0`) — giving true UDP semantics (no TCP head-of-line blocking)
// while keeping Durable Object WebSocket request counts near zero (<500/day).
//
// Signaling rides over the existing `/lan` WebSocket via `RoomSwitchDO`:
//   { t: 'rtc-offer' | 'rtc-answer' | 'rtc-ice', to: <vip>, data: ... }
// Any peer whose DataChannel is not open seamlessly falls back to the DO WebSocket.

const MAX_MESH_PEERS = 16;

interface PeerConn {
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  open: boolean;
  pendingIce: RTCIceCandidateInit[];
}

export class WebRTCMesh {
  private selfVip = 0;
  private peers = new Map<number, PeerConn>();
  private iceServers: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];
  private iceLoaded = false;
  private closed = false;
  p2pOut = 0;
  p2pIn = 0;

  constructor(
    private sendSignal: (msg: Record<string, unknown>) => void,
    private onFrame: (buf: ArrayBuffer) => void,
    private log: (s: string) => void,
  ) {}

  static supported(): boolean {
    return typeof RTCPeerConnection !== 'undefined';
  }

  /** Called on `welcome` with our assigned virtual IP. */
  async start(selfVip: number): Promise<void> {
    this.selfVip = selfVip >>> 0;
    this.closed = false;
    if (!this.iceLoaded) {
      this.iceLoaded = true;
      try {
        const res = await fetch('/turn-credentials', { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json() as { iceServers?: RTCIceServer[] };
          if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
            this.iceServers = data.iceServers;
          }
        }
      } catch {
        // Default STUN remains active
      }
    }
  }

  /** Sync active room peer VIPs; deterministic initiator (`selfVip < peerVip`) avoids offer glare. */
  syncPeers(vips: number[]): void {
    if (this.closed || !this.selfVip) return;
    const active = new Set<number>();
    for (const raw of vips) {
      const v = raw >>> 0;
      if (!v || v === this.selfVip) continue;
      // Skip server virtual hosts (.1 Online lobby, .253 Free-roam hub)
      const host = v & 0xffff;
      if (host === 1 || host === 253) continue;
      active.add(v);
    }
    for (const [vip] of this.peers) {
      if (!active.has(vip)) this.dropPeer(vip);
    }
    if (active.size > MAX_MESH_PEERS) return;
    for (const vip of active) {
      if (!this.peers.has(vip) && this.selfVip < vip) {
        void this.initiate(vip);
      }
    }
  }

  /** Attempt to send a binary virtual-LAN frame directly over P2P DataChannel. Returns true if sent. */
  send(dstVip: number, frame: Uint8Array): boolean {
    const p = this.peers.get(dstVip >>> 0);
    if (!p || !p.open || !p.dc || p.dc.readyState !== 'open') return false;
    if (p.dc.bufferedAmount > 65536) return false; // backpressure -> drop or fall back
    try {
      const copy = new Uint8Array(frame.byteLength);
      copy.set(frame);
      p.dc.send(copy);
      this.p2pOut++;
      return true;
    } catch {
      return false;
    }
  }

  /** Handle incoming signaling message from RoomSwitchDO. */
  async onSignal(t: string, fromVip: number, data: unknown): Promise<void> {
    if (this.closed || !this.selfVip) return;
    const vip = fromVip >>> 0;
    if (!vip || vip === this.selfVip) return;

    if (t === 'rtc-offer') {
      if (this.peers.size >= MAX_MESH_PEERS && !this.peers.has(vip)) return;
      this.dropPeer(vip);
      const entry = this.createPeer(vip);
      try {
        await entry.pc.setRemoteDescription(new RTCSessionDescription(data as RTCSessionDescriptionInit));
        await this.flushIce(entry);
        const ans = await entry.pc.createAnswer();
        await entry.pc.setLocalDescription(ans);
        this.sendSignal({ t: 'rtc-answer', to: vip, data: { type: ans.type, sdp: ans.sdp } });
      } catch {
        this.dropPeer(vip);
      }
      return;
    }

    const entry = this.peers.get(vip);
    if (!entry) return;

    if (t === 'rtc-answer') {
      try {
        if (entry.pc.signalingState === 'have-local-offer') {
          await entry.pc.setRemoteDescription(new RTCSessionDescription(data as RTCSessionDescriptionInit));
          await this.flushIce(entry);
        }
      } catch {
        this.dropPeer(vip);
      }
      return;
    }

    if (t === 'rtc-ice' && data) {
      const cand = data as RTCIceCandidateInit;
      if (entry.pc.remoteDescription) {
        try { await entry.pc.addIceCandidate(new RTCIceCandidate(cand)); } catch { /* ignore late candidate */ }
      } else {
        entry.pendingIce.push(cand);
      }
    }
  }

  private createPeer(vip: number): PeerConn {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const entry: PeerConn = { pc, dc: null, open: false, pendingIce: [] };
    this.peers.set(vip, entry);

    pc.onicecandidate = (e) => {
      if (e.candidate && !this.closed) {
        this.sendSignal({ t: 'rtc-ice', to: vip, data: e.candidate.toJSON() });
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        if (this.peers.get(vip) === entry) this.dropPeer(vip);
      }
    };
    pc.ondatachannel = (e) => {
      this.bindChannel(vip, entry, e.channel);
    };
    return entry;
  }

  private bindChannel(vip: number, entry: PeerConn, dc: RTCDataChannel): void {
    dc.binaryType = 'arraybuffer';
    entry.dc = dc;
    dc.onopen = () => {
      entry.open = true;
      this.log(`[net/rtc] P2P DataChannel open to ${(vip >>> 24)}.${(vip >>> 16) & 255}.${(vip >>> 8) & 255}.${vip & 255}`);
    };
    dc.onclose = () => { entry.open = false; };
    dc.onerror = () => { entry.open = false; };
    dc.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        this.p2pIn++;
        this.onFrame(e.data);
      }
    };
  }

  private async initiate(vip: number): Promise<void> {
    const entry = this.createPeer(vip);
    const dc = entry.pc.createDataChannel('nfsu2-udp', { ordered: false, maxRetransmits: 0 });
    this.bindChannel(vip, entry, dc);
    try {
      const offer = await entry.pc.createOffer();
      await entry.pc.setLocalDescription(offer);
      this.sendSignal({ t: 'rtc-offer', to: vip, data: { type: offer.type, sdp: offer.sdp } });
    } catch {
      this.dropPeer(vip);
    }
  }

  private async flushIce(entry: PeerConn): Promise<void> {
    const list = entry.pendingIce.splice(0);
    for (const c of list) {
      try { await entry.pc.addIceCandidate(new RTCIceCandidate(c)); } catch { /* ignore */ }
    }
  }

  dropPeer(vip: number): void {
    const v = vip >>> 0;
    const entry = this.peers.get(v);
    if (!entry) return;
    this.peers.delete(v);
    entry.open = false;
    try { entry.dc?.close(); } catch { /* ignore */ }
    try { entry.pc.close(); } catch { /* ignore */ }
  }

  reset(): void {
    for (const vip of [...this.peers.keys()]) this.dropPeer(vip);
  }

  close(): void {
    this.closed = true;
    this.reset();
  }
}
