import type {
  ClientMsg,
  ServerMsg,
  SnapshotPlayer,
  JoinBroadcastMsg,
  LeaveMsg,
  UpdateMsg,
  ChatBroadcastMsg,
  EmoteBroadcastMsg,
  BallMsg,
  RtcServerMsg,
  RtcPayload,
} from './protocol';

export interface NetworkHandlers {
  onWelcome?: (id: string) => void;
  /** join handler receives snapshot players too (slightly different shape but compatible) */
  onJoin?: (p: SnapshotPlayer | JoinBroadcastMsg) => void;
  onLeave?: (id: string) => void;
  onUpdate?: (msg: UpdateMsg) => void;
  onChat?: (msg: ChatBroadcastMsg) => void;
  onEmote?: (msg: EmoteBroadcastMsg) => void;
  onBall?: (msg: BallMsg) => void;
  onPresence?: (msg: { count: number }) => void;
  onRtc?: (msg: RtcServerMsg) => void;
}

export interface NetworkOpts {
  isBot?: boolean;
}

export class Network {
  readonly isBot: boolean;
  ws: WebSocket | null = null;
  id: string | null = null;
  connected = false;

  // updates for players we haven't seen the `join` for yet (race between
  // the server's snapshot delivery and subsequent updates).
  private readonly pendingUpdates = new Map<string, UpdateMsg[]>();
  private readonly knownIds = new Set<string>();

  constructor(
    private readonly handlers: NetworkHandlers,
    opts: NetworkOpts = {},
  ) {
    this.isBot = !!opts.isBot;
  }

  connect(): void {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws`;
    this.ws = new WebSocket(url);

    this.ws.addEventListener('open', () => { this.connected = true; });
    this.ws.addEventListener('message', (e) => this._onMessage(e.data));
    this.ws.addEventListener('close', () => { this.connected = false; });
    this.ws.addEventListener('error', (err) => {
      console.error('WS error', err);
    });
  }

  private _onMessage(raw: unknown): void {
    let msg: ServerMsg;
    try { msg = JSON.parse(String(raw)) as ServerMsg; } catch { return; }

    switch (msg.t) {
      case 'welcome':
        this.id = msg.id;
        this.handlers.onWelcome?.(msg.id);
        break;

      case 'snapshot':
        for (const p of msg.players) {
          this.knownIds.add(p.id);
          this.handlers.onJoin?.(p);
        }
        break;

      case 'join': {
        this.knownIds.add(msg.id);
        this.handlers.onJoin?.(msg);
        const buffered = this.pendingUpdates.get(msg.id);
        if (buffered) {
          for (const u of buffered) this.handlers.onUpdate?.(u);
          this.pendingUpdates.delete(msg.id);
        }
        break;
      }

      case 'leave': {
        const m = msg as LeaveMsg;
        this.knownIds.delete(m.id);
        this.pendingUpdates.delete(m.id);
        this.handlers.onLeave?.(m.id);
        break;
      }

      case 'update': {
        if (!this.knownIds.has(msg.id)) {
          let q = this.pendingUpdates.get(msg.id);
          if (!q) { q = []; this.pendingUpdates.set(msg.id, q); }
          q.push(msg);
          if (q.length > 8) q.shift();
        } else {
          this.handlers.onUpdate?.(msg);
        }
        break;
      }

      case 'chat':
        this.handlers.onChat?.(msg);
        break;

      case 'emote':
        this.handlers.onEmote?.(msg);
        break;

      case 'ball':
        this.handlers.onBall?.(msg);
        break;

      case 'presence':
        this.handlers.onPresence?.({ count: msg.count });
        break;

      case 'rtc':
        this.handlers.onRtc?.(msg);
        break;
    }
  }

  send(msg: ClientMsg): void {
    if (this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  sendJoin(drawingDataURL: string): void {
    this.send({ t: 'join', drawing: drawingDataURL, bot: this.isBot });
  }

  sendMove(x: number, y: number, z: number, rotY: number): void {
    this.send({ t: 'move', x, y, z, rotY });
  }

  sendChat(text: string): void {
    this.send({ t: 'chat', text });
  }

  sendEmote(name: 'dance' | 'bow', on?: boolean): void {
    const msg: ClientMsg = typeof on === 'boolean'
      ? { t: 'emote', name, on }
      : { t: 'emote', name };
    this.send(msg);
  }

  sendRtc(to: string, payload: RtcPayload): void {
    this.send({ t: 'rtc', to, payload });
  }
}
