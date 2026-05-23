export class Network {
  constructor(handlers) {
    this.handlers = handlers;
    this.ws = null;
    this.id = null;
    this.connected = false;
    this.pendingUpdates = new Map();
    this.knownIds = new Set();
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.hostname}:8080`;
    this.ws = new WebSocket(url);

    this.ws.addEventListener('open', () => {
      this.connected = true;
    });

    this.ws.addEventListener('message', (e) => this._onMessage(e.data));

    this.ws.addEventListener('close', () => {
      this.connected = false;
    });

    this.ws.addEventListener('error', (err) => {
      console.error('WS error', err);
    });
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

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

      case 'join':
        this.knownIds.add(msg.id);
        this.handlers.onJoin?.(msg);
        const buffered = this.pendingUpdates.get(msg.id);
        if (buffered) {
          for (const u of buffered) this.handlers.onUpdate?.(u);
          this.pendingUpdates.delete(msg.id);
        }
        break;

      case 'leave':
        this.knownIds.delete(msg.id);
        this.pendingUpdates.delete(msg.id);
        this.handlers.onLeave?.(msg.id);
        break;

      case 'update':
        if (!this.knownIds.has(msg.id)) {
          if (!this.pendingUpdates.has(msg.id)) this.pendingUpdates.set(msg.id, []);
          const q = this.pendingUpdates.get(msg.id);
          q.push(msg);
          if (q.length > 8) q.shift();
        } else {
          this.handlers.onUpdate?.(msg);
        }
        break;

      case 'chat':
        this.handlers.onChat?.(msg);
        break;
    }
  }

  send(msg) {
    if (this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  sendJoin(drawingDataURL) {
    this.send({ t: 'join', drawing: drawingDataURL });
  }

  sendMove(x, z, rotY) {
    this.send({ t: 'move', x, z, rotY });
  }

  sendChat(text) {
    this.send({ t: 'chat', text });
  }
}
