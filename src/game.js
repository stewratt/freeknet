import * as THREE from 'three';
import { LocalPlayer, RemotePlayer } from './player.js';
import { setupControls } from './controls.js';
import { Network } from './network.js';
import { ChatManager, setupChatInput } from './chat.js';
import { createAvatarFromDataURL } from './avatar.js';
import { createStage } from './stage.js';
import { Ball } from './ball.js';

const MOVE_SEND_INTERVAL = 1 / 15;

export function startGame(drawingCanvas) {
  const canvas = document.getElementById('game-canvas');

  const isTouch =
    (window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches) ||
    ('ontouchstart' in window && navigator.maxTouchPoints > 0);
  if (isTouch) document.body.classList.add('touch');

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !isTouch });
  const dprCap = isTouch ? 1.5 : 2;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, dprCap));
  renderer.setSize(window.innerWidth, window.innerHeight);
  const HORIZON_COLOR = 0xf2f2f2;
  renderer.setClearColor(HORIZON_COLOR, 1);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(HORIZON_COLOR, 30, 90);

  const camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  );

  const hemi = new THREE.HemisphereLight(0xffffff, 0xeeeeee, 1.0);
  scene.add(hemi);

  // gradient skydome
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      topColor:    { value: new THREE.Color(0xdde6f0) },
      horizonColor:{ value: new THREE.Color(0xf2f2f2) },
      groundColor: { value: new THREE.Color(0xe6e6e6) },
      exponent:    { value: 0.7 },
    },
    vertexShader: `
      varying vec3 vWorld;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 horizonColor;
      uniform vec3 groundColor;
      uniform float exponent;
      varying vec3 vWorld;
      void main() {
        float h = normalize(vWorld).y;
        vec3 col;
        if (h > 0.0) {
          col = mix(horizonColor, topColor, pow(h, exponent));
        } else {
          col = mix(horizonColor, groundColor, pow(-h, exponent));
        }
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(500, 32, 16), skyMat);
  scene.add(sky);

  // floor: slightly darker than horizon so the meeting line reads
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 400),
    new THREE.MeshBasicMaterial({ color: 0xe6e6e6, fog: true })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.001;
  scene.add(floor);

  // grid for spatial orientation
  const grid = new THREE.GridHelper(200, 80, 0x999999, 0xc8c8c8);
  grid.material.transparent = true;
  grid.material.opacity = 0.6;
  grid.material.depthWrite = false;
  scene.add(grid);

  const { colliders } = createStage(scene);
  const ball = new Ball(scene);

  const local = new LocalPlayer(drawingCanvas);
  scene.add(local.group);

  const remotes = new Map();
  const drawingsById = new Map();

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
    camera
  );

  const network = new Network({
    onWelcome: (id) => {
      const dataURL = drawingCanvas.toDataURL('image/png');
      network.sendJoin(dataURL);
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
  });
  network.connect();

  window.__game = {
    network,
    local,
    remotes,
    scene,
    renderer,
    chat,
  };

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  });

  const clock = new THREE.Clock();
  let moveSendTimer = 0;

  function frame() {
    const dt = Math.min(clock.getDelta(), 1 / 20);

    controls.update(dt);
    local.update(dt, input, camCtl.yaw, colliders);

    const cy = Math.cos(camCtl.yaw);
    const sy = Math.sin(camCtl.yaw);
    const cp = Math.cos(camCtl.pitch);
    const sp = Math.sin(camCtl.pitch);
    const camOffset = new THREE.Vector3(
      sy * cp * camCtl.distance,
      sp * camCtl.distance + 1.5,
      cy * cp * camCtl.distance
    );
    const target = new THREE.Vector3(local.position.x, local.position.y + 1.0, local.position.z);
    camera.position.copy(target).add(camOffset);
    camera.lookAt(target);

    local.billboardTo(camera.position);

    for (const rp of remotes.values()) {
      rp.update(dt, camera.position);
    }

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
