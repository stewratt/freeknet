// shared wire protocol types. server.ts and the client both import this.
//
// every message is JSON over a single WebSocket at /ws. types are kept
// minimal — the actual server validates input lazily and the client treats
// missing fields as defaults.

// ---- client → server ----------------------------------------------------

export interface JoinMsg {
  t: 'join';
  drawing: string; // data:image/png;base64,...
  bot?: boolean; // default false; bots may set true so the server
  // can split them from the human count.
}

export interface MoveMsg {
  t: 'move';
  x: number;
  y: number;
  z: number;
  rotY: number;
}

export interface ChatMsg {
  t: 'chat';
  text: string; // server slices to <=120 chars
}

export interface EmoteMsg {
  t: 'emote';
  name: 'dance' | 'bow';
  on?: boolean; // only used for toggle-style emotes (dance)
}

export interface RtcClientMsg {
  t: 'rtc';
  to: string; // remote peer id
  payload: RtcPayload;
}

export type ClientMsg = JoinMsg | MoveMsg | ChatMsg | EmoteMsg | RtcClientMsg;

// ---- server → client ----------------------------------------------------

export interface WelcomeMsg {
  t: 'welcome';
  id: string;
}

export interface SnapshotPlayer {
  id: string;
  drawing: string;
  x: number;
  y: number;
  z: number;
  rotY: number;
  dance: boolean;
  bot: boolean;
}

export interface SnapshotMsg {
  t: 'snapshot';
  players: SnapshotPlayer[];
}

export interface JoinBroadcastMsg {
  t: 'join';
  id: string;
  drawing: string;
  x: number;
  y: number;
  z: number;
  rotY: number;
  dance: boolean;
  bot: boolean;
}

export interface LeaveMsg {
  t: 'leave';
  id: string;
}

export interface UpdateMsg {
  t: 'update';
  id: string;
  x: number;
  y: number;
  z: number;
  rotY: number;
}

export interface ChatBroadcastMsg {
  t: 'chat';
  id: string;
  text: string;
}

export interface EmoteBroadcastMsg {
  t: 'emote';
  id: string;
  name: 'dance' | 'bow';
  on?: boolean;
}

export interface BallMsg {
  t: 'ball';
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

export interface PresenceMsg {
  t: 'presence';
  count: number; // total online players (humans + bots)
}

export interface RtcServerMsg {
  t: 'rtc';
  from: string; // peer who sent the signal
  payload: RtcPayload;
}

export type ServerMsg =
  | WelcomeMsg
  | SnapshotMsg
  | JoinBroadcastMsg
  | LeaveMsg
  | UpdateMsg
  | ChatBroadcastMsg
  | EmoteBroadcastMsg
  | BallMsg
  | PresenceMsg
  | RtcServerMsg;

// ---- WebRTC signaling payload ------------------------------------------

// the server is a dumb relay for rtc messages — it doesn't introspect this.
// the two shapes the client uses are SDP offer/answer and an ICE candidate.
// either field is optional so we can extend later (e.g. with renegotiate
// nudges) without changing the message envelope.
export interface RtcPayload {
  sdp?: RTCSessionDescriptionInit;
  ice?: RTCIceCandidateInit;
}
