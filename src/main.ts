import { setupDrawing } from './drawing';
import { startGame } from './game';

const drawPhase = document.getElementById('draw-phase') as HTMLElement;
const gamePhase = document.getElementById('game-phase') as HTMLElement;
const hud = document.getElementById('hud') as HTMLElement;
const chatBar = document.getElementById('chat-bar') as HTMLElement;

setupDrawing({
  onEnter: (drawingCanvas) => {
    drawPhase.style.display = 'none';
    gamePhase.style.display = 'block';
    hud.style.display = 'block';
    chatBar.style.display = 'block';
    startGame(drawingCanvas);
  },
});
