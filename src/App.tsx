/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';

// --- Constants & Config ---
const ROAD_COLOR = '#121212';
const LANE_LINE_COLOR = '#00f2ff'; // Neon Cyan
const PLAYER_COLOR = '#e5e7eb'; // Silver
const FUEL_COLOR = '#fbbf24';   // Gold/Yellow
const BARRIER_COLOR = '#374151';
const ENEMY_COLORS = ['#ef4444', '#3b82f6', '#10b981', '#8b5cf6'];

const ROAD_WIDTH_PCT = 0.8;
const LANE_COUNT = 4;
const FRICTION = 0.95;
const ACCELERATION = 0.15;
const MAX_SPEED_LOW = 5;
const MAX_SPEED_HIGH = 12;
const FUEL_DRIP_RATE_BASE = 0.04;
const FUEL_COLLECT_BOOST = 25;
const STAGE_LENGTH = 70000; // ~90-120 seconds

enum GameState {
  START,
  PLAYING,
  GAMEOVER,
  FINISHED
}

enum Gear {
  LOW,
  HIGH
}

interface GameObject {
  x: number;
  y: number;
  width: number;
  height: number;
  speed: number;
  type: 'car' | 'truck' | 'erratic' | 'fuel';
  color: string;
  lane: number;
  targetLane?: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [gameState, setGameState] = useState<GameState>(GameState.START);
  const [score, setScore] = useState(0);
  const [finalDistance, setFinalDistance] = useState(0);

  // Game instance variables (using ref to avoid re-renders)
  const gameRef = useRef({
    player: {
      x: 0,
      y: 0,
      width: 30,
      height: 50,
      vx: 0,
      speed: 0,
      fuel: 100,
      gear: Gear.LOW,
      distance: 0,
      skidding: 0, // 0: no, -1: left, 1: right
      skidCorrectionNeeded: 0,
      isExploded: false,
      outOfFuel: false
    },
    enemies: [] as GameObject[],
    particles: [] as Particle[],
    roadOffset: 0,
    keys: {} as Record<string, boolean>,
    lastEnemyTime: 0,
    lastFuelTime: 0,
    lastForcedFuelTime: 0,
    canvasWidth: 0,
    canvasHeight: 0,
    roadLeft: 0,
    roadWidth: 0,
    laneWidth: 0,
    startTime: 0,
    playTime: 0
  });

  const initGame = () => {
    const { player } = gameRef.current;
    const w = gameRef.current.canvasWidth;
    const h = gameRef.current.canvasHeight;

    player.x = w / 2 - player.width / 2;
    player.y = h - 120;
    player.vx = 0;
    player.speed = 0;
    player.fuel = 100;
    player.gear = Gear.LOW;
    player.distance = 0;
    player.skidding = 0;
    player.isExploded = false;
    player.outOfFuel = false;
    gameRef.current.enemies = [];
    gameRef.current.particles = [];
    gameRef.current.roadOffset = 0;
    gameRef.current.lastEnemyTime = 0;
    gameRef.current.lastFuelTime = 0;
    gameRef.current.lastForcedFuelTime = 0;
    gameRef.current.startTime = Date.now();
    gameRef.current.playTime = 0;
  };

  const spawnEnemy = (laneSelection?: number) => {
    const g = gameRef.current;
    const { roadLeft, laneWidth } = g;
    const lane = laneSelection ?? Math.floor(Math.random() * LANE_COUNT);
    const typeRoll = Math.random();
    
    let type: GameObject['type'] = 'car';
    let width = 30;
    let height = 50;
    let color = ENEMY_COLORS[Math.floor(Math.random() * ENEMY_COLORS.length)];
    
    // Difficulty ramp: increase base enemy speed over time
    const difficultyScale = Math.min(g.playTime / 60000, 1.5); // Max 1.5 extra speed after 60s
    let speed = (2 + Math.random() * 3) + difficultyScale;

    if (typeRoll > 0.85) {
      type = 'truck';
      height = 90;
      color = '#6b7280';
      speed = 1.5 + Math.random() * 2;
    } else if (typeRoll > 0.6) {
      type = 'erratic';
      color = '#f97316'; // Orange
      speed = 3 + Math.random() * 4;
    }

    const x = roadLeft + lane * laneWidth + (laneWidth - width) / 2;
    
    gameRef.current.enemies.push({
      x,
      y: -200,
      width,
      height,
      type,
      color,
      speed,
      lane
    });
  };

  const spawnFuel = () => {
    const g = gameRef.current;
    const { roadLeft, laneWidth, enemies } = g;
    
    // Prefer sides or clear lanes
    let lane = Math.random() > 0.6 ? (Math.random() > 0.5 ? 0 : 3) : Math.floor(Math.random() * LANE_COUNT);
    
    // Basic collision avoidance with other spawns
    const hasOverlap = enemies.some(e => e.lane === lane && e.y < 0);
    if (hasOverlap) {
        // Try to find a free lane
        const freeLanes = [0, 1, 2, 3].filter(l => !enemies.some(e => e.lane === l && e.y < 0));
        if (freeLanes.length > 0) lane = freeLanes[Math.floor(Math.random() * freeLanes.length)];
    }

    const width = 25;
    const height = 25;
    const x = roadLeft + lane * laneWidth + (laneWidth - width) / 2;

    g.enemies.push({
      x,
      y: -200,
      width,
      height,
      type: 'fuel',
      color: FUEL_COLOR,
      speed: 0.5, // Move slower than other cars
      lane
    });
  };

  const createExplosion = (x: number, y: number, color: string) => {
    for (let i = 0; i < 30; i++) {
      gameRef.current.particles.push({
        x,
        y,
        vx: (Math.random() - 0.5) * 10,
        vy: (Math.random() - 0.5) * 10,
        life: 1.0,
        color
      });
    }
  };

  const update = (dt: number) => {
    if (gameState !== GameState.PLAYING) return;

    const g = gameRef.current;
    const { player, keys } = g;

    g.playTime += dt;

    if (player.isExploded) {
      player.speed *= 0.95;
      if (player.speed < 0.1) {
        setGameState(GameState.GAMEOVER);
      }
      // Update particles
      g.particles.forEach(p => {
        p.x += p.vx;
        p.y += p.vy;
        p.life -= 0.02;
      });
      g.particles = g.particles.filter(p => p.life > 0);
      
      // Enemies still move
      g.enemies.forEach(e => {
        e.y += (player.speed - e.speed);
      });
      return;
    }

    // --- Input & Physics ---
    if (player.fuel > 0) {
      if (keys['ArrowUp'] || keys['w']) {
        const max = player.gear === Gear.HIGH ? MAX_SPEED_HIGH : MAX_SPEED_LOW;
        player.speed = Math.min(player.speed + ACCELERATION, max);
      } else if (keys['ArrowDown'] || keys['s']) {
        player.speed = Math.max(player.speed - ACCELERATION * 2, 0);
      } else {
        player.speed = Math.max(player.speed - ACCELERATION * 0.5, 0);
      }
    } else {
      // Out of fuel logic: gradual deceleration
      player.outOfFuel = true;
      player.speed = Math.max(player.speed * 0.985, 0);
      if (player.speed < 0.05) {
        setGameState(GameState.GAMEOVER);
      }
    }

    // Lateral movement
    if (player.skidding !== 0) {
      // Skidding mechanic: player must counter-steer
      const skidForce = 3 * player.skidding;
      player.x += skidForce;
      
      const counterKey = player.skidding === -1 ? 'ArrowRight' : 'ArrowLeft';
      if (keys[counterKey]) {
        player.skidCorrectionNeeded -= 0.1;
        if (player.skidCorrectionNeeded <= 0) {
          player.skidding = 0;
        }
      }
    } else {
      if (keys['ArrowLeft'] || keys['a']) {
        player.vx -= 0.8;
      }
      if (keys['ArrowRight'] || keys['d']) {
        player.vx += 0.8;
      }
    }

    player.vx *= FRICTION;
    player.x += player.vx;

    // Constraints
    if (player.x < g.roadLeft) {
      player.x = g.roadLeft;
      player.vx = 0;
      if (player.speed > 2) {
         createExplosion(player.x, player.y, PLAYER_COLOR);
         player.isExploded = true;
      }
    }
    if (player.x + player.width > g.roadLeft + g.roadWidth) {
      player.x = g.roadLeft + g.roadWidth - player.width;
      player.vx = 0;
      if (player.speed > 2) {
        createExplosion(player.x + player.width, player.y, PLAYER_COLOR);
        player.isExploded = true;
      }
    }

    // Distance & Fuel
    player.distance += player.speed;
    
    // Dynamic Fuel: speed based consumption + baseline
    const consumption = FUEL_DRIP_RATE_BASE * (player.speed / 8 + 0.2);
    player.fuel = Math.max(player.fuel - consumption, 0);
    
    if (player.distance >= STAGE_LENGTH) {
      setFinalDistance(player.distance);
      setGameState(GameState.FINISHED);
    }

    // Road offset
    g.roadOffset = (g.roadOffset + player.speed) % 100;

    // --- Gear System ---
    if (player.speed > MAX_SPEED_LOW && player.gear === Gear.LOW) {
      // Can't go higher unless shifted? Let's just do auto-shift for simplicity or toggle
      // Manual gear via Shift key? Let's do auto-shift at threshold for now but UI shows it
    }
    if (keys['Shift']) {
        player.gear = Gear.HIGH;
    } else {
        if (player.speed > MAX_SPEED_LOW) {
            // sustain if already high, or maybe need to hold it?
            player.gear = Gear.HIGH;
        } else {
            player.gear = Gear.LOW;
        }
    }

    // --- Enemies & Fuel Spawning ---
    const currentTime = Date.now();
    // Base enemy spawn
    if (currentTime - g.lastEnemyTime > 1800 / (1 + player.distance / 10000)) {
      spawnEnemy();
      g.lastEnemyTime = currentTime;
    }
    
    // Normal Fuel spawn (increase frequency)
    if (currentTime - g.lastFuelTime > 6000) {
      spawnFuel();
      g.lastFuelTime = currentTime;
    }

    // Survival Insurance: if fuel < 15%, force spawn fuel within 3 seconds
    if (player.fuel < 15 && player.fuel > 0 && !player.isExploded) {
        if (currentTime - g.lastForcedFuelTime > 3000) {
            spawnFuel();
            g.lastForcedFuelTime = currentTime;
        }
    }

    g.enemies.forEach(e => {
        // Enmies move relative to road speed
        // If they have speed 3 and player has speed 5, they move down at 2
        e.y += (player.speed - e.speed);

        if (e.type === 'erratic' && Math.abs(e.y - player.y) < 200 && e.y < player.y) {
           if (e.targetLane === undefined && Math.random() < 0.02) {
               e.targetLane = e.lane + (Math.random() > 0.5 ? 1 : -1);
               if (e.targetLane < 0) e.targetLane = 1;
               if (e.targetLane >= LANE_COUNT) e.targetLane = LANE_COUNT - 2;
           }
           if (e.targetLane !== undefined) {
               const targetX = g.roadLeft + e.targetLane * g.laneWidth + (g.laneWidth - e.width) / 2;
               if (e.x < targetX) e.x += 2;
               if (e.x > targetX) e.x -= 2;
               if (Math.abs(e.x - targetX) < 5) e.targetLane = undefined;
           }
        }

        // Collision detection
        if (
            player.x < e.x + e.width &&
            player.x + player.width > e.x &&
            player.y < e.y + e.height &&
            player.y + player.height > e.y
        ) {
            if (e.type === 'fuel') {
                player.fuel = Math.min(player.fuel + FUEL_COLLECT_BOOST, 100);
                e.y = 2000; // Remove
            } else {
                // Check if it's a side collision or front
                const overlapX = Math.min(player.x + player.width, e.x + e.width) - Math.max(player.x, e.x);
                const overlapY = Math.min(player.y + player.height, e.y + e.height) - Math.max(player.y, e.y);

                if (overlapX < 15) {
                    // Side nudge -> Skid
                    player.skidding = player.x < e.x ? -1 : 1;
                    player.skidCorrectionNeeded = 1.0;
                    // Push away slightly
                    player.vx = player.skidding * -5;
                } else {
                    // Head on crash
                    createExplosion(player.x + player.width/2, player.y + player.height/2, PLAYER_COLOR);
                    player.isExploded = true;
                }
            }
        }
    });

    g.enemies = g.enemies.filter(e => e.y < g.canvasHeight + 200 && e.y > -500);

    // Particles
    g.particles.forEach(p => {
        p.x += p.vx;
        p.y += p.vy;
        p.life -= 0.02;
    });
    g.particles = g.particles.filter(p => p.life > 0);
  };

  const draw = (ctx: CanvasRenderingContext2D) => {
    const g = gameRef.current;
    const { player, enemies, particles, roadLeft, roadWidth, canvasWidth, canvasHeight } = g;

    // Clear
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    // Road side
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, roadLeft, canvasHeight);
    ctx.fillRect(roadLeft + roadWidth, 0, canvasWidth - (roadLeft + roadWidth), canvasHeight);

    // Road
    ctx.fillStyle = ROAD_COLOR;
    ctx.fillRect(roadLeft, 0, roadWidth, canvasHeight);

    // Lane lines
    ctx.strokeStyle = LANE_LINE_COLOR;
    ctx.setLineDash([40, 40]);
    ctx.lineDashOffset = -g.roadOffset * 2;
    ctx.lineWidth = 2;
    for (let i = 1; i < LANE_COUNT; i++) {
        ctx.beginPath();
        const x = roadLeft + i * g.laneWidth;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvasHeight);
        ctx.stroke();
    }
    ctx.setLineDash([]);

    // Road edge
    ctx.fillStyle = '#333';
    ctx.fillRect(roadLeft - 5, 0, 5, canvasHeight);
    ctx.fillRect(roadLeft + roadWidth, 0, 5, canvasHeight);

    // Enemies
    enemies.forEach(e => {
        ctx.fillStyle = e.color;
        if (e.type === 'fuel') {
            // Draw a diamond/coin shape
            ctx.beginPath();
            ctx.moveTo(e.x + e.width / 2, e.y);
            ctx.lineTo(e.x + e.width, e.y + e.height / 2);
            ctx.lineTo(e.x + e.width / 2, e.y + e.height);
            ctx.lineTo(e.x, e.y + e.height / 2);
            ctx.closePath();
            ctx.fill();
            // Glow
            ctx.shadowBlur = 10;
            ctx.shadowColor = FUEL_COLOR;
            ctx.stroke();
            ctx.shadowBlur = 0;
            
            ctx.fillStyle = '#000';
            ctx.font = 'bold 14px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('F', e.x + e.width/2, e.y + e.height/2 + 5);
        } else {
            // Draw car pattern
            ctx.beginPath();
            ctx.roundRect(e.x, e.y, e.width, e.height, 4);
            ctx.fill();
            // Roof
            ctx.fillStyle = 'rgba(0,0,0,0.3)';
            ctx.fillRect(e.x + 5, e.y + 10, e.width - 10, e.height - 25);
            // Window
            ctx.fillStyle = 'rgba(255,255,255,0.2)';
            ctx.fillRect(e.x + 7, e.y + 12, e.width - 14, 10);
            // Lights
            ctx.fillStyle = '#fff';
            ctx.fillRect(e.x + 2, e.y + 2, 6, 4);
            ctx.fillRect(e.x + e.width - 8, e.y + 2, 6, 4);
        }
    });

    // Player
    if (!player.isExploded) {
        ctx.fillStyle = PLAYER_COLOR;
        ctx.beginPath();
        ctx.roundRect(player.x, player.y, player.width, player.height, 6);
        ctx.fill();
        
        // Luxury details
        ctx.strokeStyle = '#d4af37'; // Gold edge
        ctx.lineWidth = 1;
        ctx.stroke();

        // Roof
        ctx.fillStyle = '#111';
        ctx.fillRect(player.x + 4, player.y + 15, player.width - 8, player.height - 25);
        
        // Windshield (facing up/forward)
        ctx.fillStyle = 'rgba(100, 200, 255, 0.4)';
        ctx.fillRect(player.x + 6, player.y + 10, player.width - 12, 5);

        // Rear window
        ctx.fillRect(player.x + 6, player.y + player.height - 15, player.width - 12, 4);

        // Skid smoke or effect
        if (player.skidding !== 0) {
            ctx.fillStyle = 'rgba(255,255,255,0.3)';
            ctx.beginPath();
            ctx.arc(player.x + player.width/2, player.y + player.height, 10 + Math.random()*5, 0, Math.PI*2);
            ctx.fill();
        }
    }

    // Particles
    particles.forEach(p => {
        ctx.fillStyle = p.color;
        ctx.globalAlpha = p.life;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2 + Math.random() * 3, 0, Math.PI * 2);
        ctx.fill();
    });
    ctx.globalAlpha = 1.0;

    // --- HUD ---
    const drawHUD = () => {
        // Speed
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 24px monospace';
        ctx.textAlign = 'right';
        const speedKmh = Math.floor(player.speed * 20);
        ctx.fillText(`${speedKmh} KM/H`, canvasWidth - 20, 40);
        
        // Gear
        ctx.font = 'bold 16px monospace';
        ctx.fillStyle = player.gear === Gear.HIGH ? LANE_LINE_COLOR : '#aaa';
        ctx.fillText(player.gear === Gear.HIGH ? 'HIGH' : 'LOW', canvasWidth - 20, 65);

        // Fuel Bar
        const barW = 200;
        const barH = 15;
        const barX = 20;
        const barY = 30;
        
        const isFuelLow = player.fuel < 20;
        const blink = isFuelLow && Math.floor(Date.now() / 250) % 2 === 0;

        ctx.fillStyle = blink ? '#ef4444' : '#333';
        ctx.fillRect(barX, barY, barW, barH);
        
        const fuelGrad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
        fuelGrad.addColorStop(0, '#ef4444');
        fuelGrad.addColorStop(0.5, '#fbbf24');
        fuelGrad.addColorStop(1, '#10b981');
        
        ctx.fillStyle = blink ? '#fff' : fuelGrad;
        ctx.fillRect(barX, barY, (player.fuel / 100) * barW, barH);
        
        ctx.strokeStyle = isFuelLow ? '#ef4444' : '#fff';
        ctx.lineWidth = 1;
        ctx.strokeRect(barX, barY, barW, barH);
        ctx.fillStyle = isFuelLow ? '#ef4444' : '#fff';
        ctx.font = 'bold 12px monospace';
        ctx.textAlign = 'left';
        ctx.fillText(isFuelLow ? 'LOW FUEL!' : 'FUEL', barX, barY - 5);

        // Progress
        const progW = 10;
        const progH = canvasHeight - 200;
        const progX = 20;
        const progY = 100;
        
        ctx.fillStyle = 'rgba(255,255,255,0.1)';
        ctx.fillRect(progX, progY, progW, progH);
        
        const progress = Math.min(player.distance / STAGE_LENGTH, 1);
        ctx.fillStyle = LANE_LINE_COLOR;
        ctx.fillRect(progX, progY + progH - (progress * progH), progW, progress * progH);
        
        ctx.strokeRect(progX, progY, progW, progH);
        ctx.fillText('FINISH', progX + 15, progY + 10);
        ctx.fillText('START', progX + 15, progY + progH);
    };

    drawHUD();
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const handleResize = () => {
      if (!containerRef.current) return;
      const { clientWidth, clientHeight } = containerRef.current;
      canvas.width = clientWidth;
      canvas.height = clientHeight;
      
      gameRef.current.canvasWidth = clientWidth;
      gameRef.current.canvasHeight = clientHeight;
      gameRef.current.roadWidth = clientWidth * ROAD_WIDTH_PCT;
      gameRef.current.roadLeft = (clientWidth - gameRef.current.roadWidth) / 2;
      gameRef.current.laneWidth = gameRef.current.roadWidth / LANE_COUNT;
      
      if (gameState === GameState.START) {
          gameRef.current.player.x = clientWidth / 2 - gameRef.current.player.width / 2;
          gameRef.current.player.y = clientHeight - 120;
      }
    };

    window.addEventListener('resize', handleResize);
    handleResize();

    const handleKeyDown = (e: KeyboardEvent) => {
      gameRef.current.keys[e.key] = true;
      if (gameState === GameState.START && e.key === ' ') {
        initGame();
        setGameState(GameState.PLAYING);
      }
      if (gameState === GameState.GAMEOVER && e.key === 'r') {
        initGame();
        setGameState(GameState.PLAYING);
      }
      if (gameState === GameState.FINISHED && e.key === 'r') {
        initGame();
        setGameState(GameState.PLAYING);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      gameRef.current.keys[e.key] = false;
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    let animationFrame: number;
    const loop = () => {
      update(16); // Assuming 60fps for simplicity, or calc actual dt
      draw(ctx);
      animationFrame = requestAnimationFrame(loop);
    };

    animationFrame = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(animationFrame);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [gameState]);

  return (
    <div 
        ref={containerRef}
        className="relative w-full h-screen bg-black overflow-hidden font-mono text-white select-none"
        id="game-root"
    >
      <canvas 
        ref={canvasRef}
        className="block"
        id="game-canvas"
      />

      {/* Overlays */}
      {gameState === GameState.START && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 backdrop-blur-sm">
          <h1 className="text-6xl font-black mb-4 tracking-tighter text-transparent bg-clip-text bg-gradient-to-b from-white to-gray-500">
            SOTO RACER
          </h1>
          <p className="text-cyan-400 animate-pulse mb-12">PRESS [SPACE] TO IGNITE</p>
          <div className="grid grid-cols-2 gap-8 text-sm text-gray-400">
            <div className="flex items-center gap-2">
              <span className="bg-gray-800 px-2 py-1 rounded border border-gray-700 font-bold text-white">W / ↑</span>
              <span>Accelerate</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="bg-gray-800 px-2 py-1 rounded border border-gray-700 font-bold text-white">S / ↓</span>
              <span>Brake</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="bg-gray-800 px-2 py-1 rounded border border-gray-700 font-bold text-white">A-D / ←→</span>
              <span>Steer</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="bg-gray-800 px-2 py-1 rounded border border-gray-700 font-bold text-white">SHIFT</span>
              <span>High Gear</span>
            </div>
          </div>
          <div className="mt-12 text-center max-w-md text-xs text-gray-500 px-4">
             Pro Tip: If you nudge a car, counter-steer quickly to regain control and avoid the edge!
          </div>
        </div>
      )}

      {gameState === GameState.GAMEOVER && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-red-950/40 backdrop-blur-md">
          <h2 className="text-8xl font-black text-red-500 mb-2 drop-shadow-2xl">
            {gameRef.current.player.outOfFuel ? 'OUT OF FUEL' : 'GAME OVER'}
          </h2>
          <p className="text-white mb-2 text-xl">
             {gameRef.current.player.outOfFuel ? 'Your engine stalled...' : 'You crashed!'}
          </p>
          <p className="text-white mb-8 border-t border-white/20 pt-4">DISTANCE: {Math.floor(gameRef.current.player.distance)}m</p>
          <button 
            onClick={() => { initGame(); setGameState(GameState.PLAYING); }}
            id="restart-button"
            className="px-8 py-3 bg-white text-black font-bold rounded-full hover:bg-cyan-400 transition-all active:scale-95"
          >
            RETRY [R]
          </button>
        </div>
      )}

      {gameState === GameState.FINISHED && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-cyan-950/40 backdrop-blur-md">
          <h2 className="text-8xl font-black text-cyan-400 mb-2 drop-shadow-2xl">VICTORY</h2>
          <p className="text-white mb-2 text-2xl">STAGE COMPLETE</p>
          <p className="text-gray-300 mb-8">Final Sprint Distance: {Math.floor(finalDistance)}m</p>
          <button 
            onClick={() => { initGame(); setGameState(GameState.PLAYING); }}
            className="px-8 py-3 bg-white text-black font-bold rounded-full hover:bg-cyan-400 transition-colors"
          >
            PLAY AGAIN [R]
          </button>
        </div>
      )}

      {/* Decorative border */}
      <div className="absolute inset-0 pointer-events-none border-[12px] border-black/20" />
    </div>
  );
}
