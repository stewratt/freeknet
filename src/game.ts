import * as THREE from 'three';
import { World } from '@perplexdotgg/bounce';
import { LocalPlayer, RemotePlayer } from './player';
import { setupControls } from './controls';
import { Network } from './network';
import { ChatManager, setupChatInput } from './chat';
import { createAvatarFromDataURL } from './avatar';
import { createStage } from './stage';
import { Ball } from './ball';
import { createSky, HORIZON_COLOR } from './sky';
import { createFloor, createGrid } from './world';
import { createCamera, follow } from './camera';

const MOVE_SEND_INTERVAL = 1 / 15;

interface Query {
  isBot: boolean;
}

function parseQuery(): Query {
  const params = new URLSearchParams(location.search);
  return {
    isBot: params.get('bot') === '1' || params.get('bot') === 'true',
  };
}

declare global {
  interface Window {
    __game?: {
      network: Network;
      local: LocalPlayer;
      remotes: Map<string, RemotePlayer>;
      scene: THREE.Scene;
      renderer: THREE.WebGLRenderer;
      chat: ChatManager;
    };
  }
}

export function startGame(drawingCanvas: HTMLCanvasElement): void {
  const { isBot } = parseQuery();
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;

  const isTouch =
    (window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches) ||
    ('ontouchstart' in window && navigator.maxTouchPoints > 0);
  if (isTouch) document.body.classList.add('touch');

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !isTouch });
  const dprCap = isTouch ? 1.5 : 2;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, dprCap));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(HORIZON_COLOR, 1);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(HORIZON_COLOR, 30, 90);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xeeeeee, 1.0));
  scene.add(createSky());
  scene.add(createFloor());
  scene.add(createGrid());

  const camera = createCamera(window.innerWidth / window.innerHeight);

  // client-side physics world: drives the local player's character
  // controller and registers the static stage geometry so the controller
  // can collide against it. the server has its own independent world for
  // ball physics — neither knows about the other.
  const physicsWorld = new World({
    gravity: [0, -22, 0],
    timeStepSizeSeconds: 1 / 60,
  });

  createStage(scene, physicsWorld);
  const ball = new Ball(scene);

  const local = new LocalPlayer(drawingCanvas, physicsWorld);
  scene.add(local.group);

  const remotes = new Map<string, RemotePlayer>();
  const drawingsById = new Map<string, string>();

  const chatInput = setupChatInput({
    onSend: (text) => network.sendChat(text),
    onCommand: (cmd) => {
      const word = cmd.trim().toLowerCase().split(/\s+/)[0];
      if (word === '/dance') {
        const on = local.toggleDance();
        network.sendEmote('dance', on);
      } else if (word === '/bow') {
        local.startBow();
        network.sendEmote('bow');
      }
    },
  });

  const controls = setupControls(canvas, {
    isChatActive: () => chatInput.isActive(),
  });
  const { input, camera: camCtl } = controls;

  const chat = new ChatManager(
    scene,
    (id) => {
      if (id === network.id) {
        return new THREE.Vector3().copy(local.position);
      }
      const r = remotes.get(id);
      return r ? new THREE.Vector3().copy(r.position) : null;
    },
    camera,
  );

  const presenceEl = document.getElementById('presence');

  const network = new Network(
    {
      onWelcome: () => {
        const dataURL = drawingCanvas.toDataURL('image/png');
        network.sendJoin(dataURL);
      },
      onPresence: ({ count }) => {
        if (!presenceEl) return;
        presenceEl.textContent = `${count} online`;
      },
      onJoin: async (p) => {
        if (p.id === network.id) return;
        if (remotes.has(p.id)) return;
        const rp = new RemotePlayer(p);
        remotes.set(p.id, rp);
        scene.add(rp.group);
        drawingsById.set(p.id, p.drawing);
        try {
          const mesh = await createAvatarFromDataURL(p.drawing);
          rp.setAvatar(mesh);
        } catch (e) {
          console.error('failed to build remote avatar', e);
        }
      },
      onLeave: (id) => {
        const rp = remotes.get(id);
        if (rp) {
          scene.remove(rp.group);
          if (rp.avatar) {
            rp.avatar.geometry.dispose();
            rp.avatar.material.map?.dispose();
            rp.avatar.material.dispose();
          }
          remotes.delete(id);
        }
        drawingsById.delete(id);
        chat.clearForPlayer(id);
      },
      onUpdate: (msg) => {
        const rp = remotes.get(msg.id);
        if (rp) rp.pushUpdate(msg.x, msg.y ?? 0, msg.z);
      },
      onChat: (msg) => {
        chat.add(msg.id, msg.text);
      },
      onEmote: (msg) => {
        const rp = remotes.get(msg.id);
        if (!rp) return;
        if (msg.name === 'dance') rp.setDance(!!msg.on);
        else if (msg.name === 'bow') rp.startBow();
      },
      onBall: (msg) => {
        ball.receiveState(msg.x, msg.y, msg.z, msg.vx ?? 0, msg.vy ?? 0, msg.vz ?? 0);
      },
    },
    { isBot },
  );
  network.connect();

  // expose game internals for smoke tests / debugging. dev only.
  if (import.meta.env?.DEV) {
    window.__game = { network, local, remotes, scene, renderer, chat };
  }

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  });

  const clock = new THREE.Clock();
  let moveSendTimer = 0;

  function frame(): void {
    const dt = Math.min(clock.getDelta(), 1 / 20);

    controls.update(dt);
    // step the physics world BEFORE the character controller's update, per
    // bounce's recommendation. this resolves any pending dynamic bodies
    // before the controller's shape-casts query the world.
    physicsWorld.takeOneStep(dt);
    local.update(dt, input, camCtl.yaw);
    follow(camera, camCtl, local.position);
    local.billboardTo(camera.position);

    for (const rp of remotes.values()) rp.update(dt, camera.position);
    ball.update(dt);
    chat.update(dt);

    moveSendTimer += dt;
    if (moveSendTimer >= MOVE_SEND_INTERVAL && network.connected && network.id) {
      moveSendTimer = 0;
      network.sendMove(local.position.x, local.position.y, local.position.z, camCtl.yaw);
    }

    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  frame();
}
