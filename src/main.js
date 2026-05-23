import { setupDrawing } from './drawing.js';
import { startGame } from './game.js';

const drawPhase = document.getElementById('draw-phase');
const gamePhase = document.getElementById('game-phase');
const hud = document.getElementById('hud');
const chatBar = document.getElementById('chat-bar');

setupDrawing({
  onEnter: (drawingCanvas) => {
    drawPhase.style.display = 'none';
    gamePhase.style.display = 'block';
    hud.style.display = 'block';
    chatBar.style.display = 'block';
    startGame(drawingCanvas);
  },
});
