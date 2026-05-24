// proximity voice chat over webrtc, mesh topology.
//
// design
// ------
// every nearby pair of players holds an RTCPeerConnection carrying audio in
// both directions. we open a connection when the remote is within
// PROXIMITY_OPEN, and tear it down when they go past PROXIMITY_CLOSE (the gap
// is hysteresis so a player walking the boundary doesn't flap).
//
// to avoid both sides offering simultaneously, the player with the smaller
// id is the offerer. signaling rides on the existing ws server as `rtc`
// messages — see server.ts. nothing other than SDP and ICE candidates flow
// through the server; the actual audio is peer-to-peer.
//
// each remote stream is piped through a Web Audio PannerNode (HRTF) so the
// audio is spatial: someone to your left sounds like they're on your left.
// the AudioContext listener follows the local player position and yaw.

import * as THREE from 'three';
import type { RtcServerMsg, RtcPayload } from './protocol';

const PROXIMITY_OPEN = 35;
const PROXIMITY_CLOSE = 45;
const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

export interface RemoteLike {
  position: THREE.Vector3;
}

export interface VoiceManagerOpts {
  getLocalId: () => string | null;
  sendSignal: (to: string, payload: RtcPayload) => void;
  getRemotes: () => Map<string, RemoteLike>;
  getLocalPosition: () => THREE.Vector3;
  getLocalYaw: () => number;
}

interface PeerState {
  pc: RTCPeerConnection;
  panner: PannerNode;
  audioEl: HTMLAudioElement | null;
  remoteStream: MediaStream | null;
  remoteDescSet: boolean;
}

// older safari exposes setPosition / setOrientation directly on the listener
// instead of the modern AudioParam-per-axis API. these aren't in the
// standard AudioListener lib types, so declare them locally.
interface LegacyAudioListener {
  setPosition(x: number, y: number, z: number): void;
  setOrientation(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void;
}

// the webkit prefix is non-standard. cast through a small interface so we
// don't pollute Window globally.
interface AudioCtxWindow {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
}

export class VoiceManager {
  enabled = false;
  muted = false;
  localStream: MediaStream | null = null;

  readonly peers = new Map<string, PeerState>();
  audioCtx: AudioContext | null = null;

  // queued ICE candidates that arrived before the remote description was
  // applied. flushed once setRemoteDescription resolves.
  private readonly queuedIce = new Map<string, RTCIceCandidateInit[]>();

  private readonly getLocalId: VoiceManagerOpts['getLocalId'];
  private readonly sendSignal: VoiceManagerOpts['sendSignal'];
  private readonly getRemotes: VoiceManagerOpts['getRemotes'];
  private readonly getLocalPosition: VoiceManagerOpts['getLocalPosition'];
  private readonly getLocalYaw: VoiceManagerOpts['getLocalYaw'];

  constructor(opts: VoiceManagerOpts) {
    this.getLocalId = opts.getLocalId;
    this.sendSignal = opts.sendSignal;
    this.getRemotes = opts.getRemotes;
    this.getLocalPosition = opts.getLocalPosition;
    this.getLocalYaw = opts.getLocalYaw;
  }

  // ---- public API ------------------------------------------------------

  async enable(): Promise<void> {
    if (this.enabled) return;
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (e) {
      console.warn('voice: mic permission denied', e);
      throw e;
    }
    this._ensureAudioCtx();
    this.enabled = true;
  }

  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    // snapshot the keys first — _closePeer mutates this.peers, so
    // iterating the live map would skip entries.
    const peerIds = Array.from(this.peers.keys());
    for (const id of peerIds) this._closePeer(id);
    if (this.localStream) {
      for (const t of this.localStream.getTracks()) t.stop();
      this.localStream = null;
    }
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.localStream) {
      for (const t of this.localStream.getAudioTracks()) t.enabled = !this.muted;
    }
    return this.muted;
  }

  // called by network.onRtc
  async onSignal(msg: RtcServerMsg): Promise<void> {
    if (!this.enabled) return;
    const { from, payload } = msg;
    if (!from || !payload) return;
    if (payload.sdp) {
      await this._onSdp(from, payload.sdp);
    } else if (payload.ice) {
      await this._onIce(from, payload.ice);
    }
  }

  // called by network.onLeave
  onPeerLeft(id: string): void {
    this._closePeer(id);
  }

  /**
   * called once per frame from the game loop. opens/closes peers based on
   * proximity and updates the spatial audio listener + panner positions.
   */
  update(_dt: number): void {
    if (!this.enabled || !this.audioCtx) return;
    this._updateListener();
    const remotes = this.getRemotes();
    const local = this.getLocalPosition();
    const myId = this.getLocalId();
    if (!myId) return;

    // open new peers, close far ones
    for (const [rid, rp] of remotes) {
      const dx = rp.position.x - local.x;
      const dy = (rp.position.y ?? 0) - (local.y ?? 0);
      const dz = rp.position.z - local.z;
      const dist = Math.hypot(dx, dy, dz);

      const state = this.peers.get(rid);
      if (!state && dist < PROXIMITY_OPEN) {
        // initiator election: smaller id offers.
        const iAmInitiator = myId < rid;
        void this._openPeer(rid, iAmInitiator);
      } else if (state && dist > PROXIMITY_CLOSE) {
        this._closePeer(rid);
        continue;
      }

      // pan the audio for this peer
      const peer = this.peers.get(rid);
      if (peer?.panner && this.audioCtx) {
        const now = this.audioCtx.currentTime;
        peer.panner.positionX.setValueAtTime(rp.position.x, now);
        peer.panner.positionY.setValueAtTime(rp.position.y ?? 0, now);
        peer.panner.positionZ.setValueAtTime(rp.position.z, now);
      }
    }

    // close peers for vanished remotes. snapshot the keys first because
    // _closePeer mutates this.peers, so iterating the live map would skip
    // entries.
    const knownPeerIds = Array.from(this.peers.keys());
    for (const rid of knownPeerIds) {
      if (!remotes.has(rid)) this._closePeer(rid);
    }
  }

  // ---- internals -------------------------------------------------------

  private _ensureAudioCtx(): void {
    if (this.audioCtx) return;
    const w = window as unknown as AudioCtxWindow;
    const Ctx = w.AudioContext || w.webkitAudioContext;
    if (!Ctx) {
      throw new Error('voice: no AudioContext available');
    }
    this.audioCtx = new Ctx();
    // safari/chrome both want a user gesture before resume; the mic button
    // click satisfies that since this is called from a click handler chain.
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }
  }

  private _updateListener(): void {
    if (!this.audioCtx) return;
    const lis = this.audioCtx.listener;
    const pos = this.getLocalPosition();
    const yaw = this.getLocalYaw();
    const now = this.audioCtx.currentTime;

    // listener position
    if (lis.positionX) {
      lis.positionX.setValueAtTime(pos.x, now);
      lis.positionY.setValueAtTime(pos.y ?? 0, now);
      lis.positionZ.setValueAtTime(pos.z, now);
    } else {
      // older safari falls back to the deprecated setPosition API
      (lis as unknown as LegacyAudioListener).setPosition(pos.x, pos.y ?? 0, pos.z);
    }

    // listener orientation: forward vector from yaw, up = +Y.
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    if (lis.forwardX) {
      lis.forwardX.setValueAtTime(fx, now);
      lis.forwardY.setValueAtTime(0, now);
      lis.forwardZ.setValueAtTime(fz, now);
      lis.upX.setValueAtTime(0, now);
      lis.upY.setValueAtTime(1, now);
      lis.upZ.setValueAtTime(0, now);
    } else {
      (lis as unknown as LegacyAudioListener).setOrientation(fx, 0, fz, 0, 1, 0);
    }
  }

  private _makePanner(): PannerNode {
    if (!this.audioCtx) throw new Error('audioCtx not ready');
    const panner = this.audioCtx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 1;
    panner.maxDistance = PROXIMITY_CLOSE + 5;
    panner.rolloffFactor = 1.2;
    panner.coneInnerAngle = 360;
    panner.coneOuterAngle = 0;
    panner.coneOuterGain = 0;
    return panner;
  }

  private async _openPeer(remoteId: string, iAmInitiator: boolean): Promise<void> {
    if (this.peers.has(remoteId)) return;
    if (!this.audioCtx || !this.localStream) return;

    const pc = new RTCPeerConnection(RTC_CONFIG);
    const panner = this._makePanner();
    panner.connect(this.audioCtx.destination);

    const state: PeerState = {
      pc,
      panner,
      audioEl: null,
      remoteStream: null,
      remoteDescSet: false,
    };
    this.peers.set(remoteId, state);

    // add our local audio
    for (const track of this.localStream.getAudioTracks()) {
      pc.addTrack(track, this.localStream);
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.sendSignal(remoteId, { ice: e.candidate.toJSON() });
      }
    };

    pc.ontrack = (e) => {
      const [stream] = e.streams;
      state.remoteStream = stream;
      // browsers need an <audio> element to be attached for autoplay quirks,
      // but we mute its output and route through Web Audio instead.
      const audioEl = document.createElement('audio');
      audioEl.srcObject = stream;
      audioEl.autoplay = true;
      audioEl.muted = true;
      state.audioEl = audioEl;

      if (!this.audioCtx) return;
      const src = this.audioCtx.createMediaStreamSource(stream);
      src.connect(panner);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this._closePeer(remoteId);
      }
    };

    if (iAmInitiator) {
      try {
        const offer = await pc.createOffer({ offerToReceiveAudio: true });
        await pc.setLocalDescription(offer);
        if (pc.localDescription) {
          this.sendSignal(remoteId, { sdp: pc.localDescription });
        }
      } catch (e) {
        console.warn('voice: failed to create offer', e);
      }
    }
  }

  private async _onSdp(remoteId: string, sdp: RTCSessionDescriptionInit): Promise<void> {
    let state = this.peers.get(remoteId);
    if (!state) {
      // unexpected offer; we're the answerer. open in non-initiator mode.
      await this._openPeer(remoteId, false);
      state = this.peers.get(remoteId);
      if (!state) return;
    }
    const pc = state.pc;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      state.remoteDescSet = true;
      // flush any queued ICE
      const queued = this.queuedIce.get(remoteId);
      if (queued) {
        for (const c of queued) {
          try {
            await pc.addIceCandidate(c);
          } catch (e) {
            console.warn('queued ice failed', e);
          }
        }
        this.queuedIce.delete(remoteId);
      }
      if (sdp.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        if (pc.localDescription) {
          this.sendSignal(remoteId, { sdp: pc.localDescription });
        }
      }
    } catch (e) {
      console.warn('voice: setRemoteDescription failed', e);
    }
  }

  private async _onIce(remoteId: string, ice: RTCIceCandidateInit): Promise<void> {
    const state = this.peers.get(remoteId);
    if (!state) return;
    if (!state.remoteDescSet) {
      // queue until the remote description is set, otherwise addIceCandidate
      // throws in chrome.
      let q = this.queuedIce.get(remoteId);
      if (!q) {
        q = [];
        this.queuedIce.set(remoteId, q);
      }
      q.push(ice);
      return;
    }
    try {
      await state.pc.addIceCandidate(ice);
    } catch (e) {
      console.warn('voice: addIceCandidate failed', e);
    }
  }

  private _closePeer(id: string): void {
    const state = this.peers.get(id);
    if (!state) return;
    try {
      state.pc.close();
    } catch {}
    try {
      state.panner.disconnect();
    } catch {}
    if (state.audioEl) {
      try {
        state.audioEl.srcObject = null;
        state.audioEl.remove();
      } catch {}
    }
    this.peers.delete(id);
    this.queuedIce.delete(id);
  }
}

interface VoiceUIOpts {
  voice: VoiceManager;
  container?: HTMLElement;
}

export function setupVoiceUI({ voice, container }: VoiceUIOpts): HTMLButtonElement | undefined {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
    return undefined;
  }

  const btn = document.createElement('button');
  btn.id = 'voice-btn';
  btn.type = 'button';
  btn.title = 'enable proximity voice (click to grant mic permission)';
  btn.textContent = '🎙 voice: off';
  btn.style.cssText = `
    position: fixed; top: 12px; right: 12px;
    padding: 6px 12px; font: inherit; font-size: 12px;
    background: rgba(255,255,255,0.9);
    border: 1px solid #bbb; border-radius: 2px;
    cursor: pointer; color: #333;
  `;
  (container ?? document.body).appendChild(btn);

  let state: 'off' | 'on' | 'muted' = 'off';

  btn.addEventListener('click', async () => {
    if (state === 'off') {
      try {
        await voice.enable();
        state = 'on';
        btn.textContent = '🎙 voice: on';
      } catch {
        btn.textContent = '🎙 mic denied';
      }
    } else if (state === 'on') {
      const muted = voice.toggleMute();
      state = muted ? 'muted' : 'on';
      btn.textContent = muted ? '🎙 muted' : '🎙 voice: on';
    } else if (state === 'muted') {
      voice.toggleMute();
      state = 'on';
      btn.textContent = '🎙 voice: on';
    }
  });

  return btn;
}
