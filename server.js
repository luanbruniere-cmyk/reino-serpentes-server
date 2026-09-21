/* ============================================================
   Reino das Serpentes — Servidor Multiplayer
   Sala única, aberta pra qualquer jogador entrar.
   Zero dependências: só usa os módulos nativos do Node
   (não precisa rodar "npm install" pra funcionar).
   Deploy: qualquer host Node.js grátis (Render, Glitch, Fly.io...).
============================================================ */
'use strict';
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const MAP_RADIUS = 4600;
const FOOD_TARGET = 260;
const TICK_MS = 120;              // ~8 atualizações por segundo pra todo mundo
const IDLE_TIMEOUT_MS = 20000;    // desconecta quem sumiu sem avisar

/* ---------- WebSocket mínimo (RFC 6455), sem libs ---------- */
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function acceptKeyFor(key){ return crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64'); }

function encodeFrame(payloadBuf, opcode){
  const len = payloadBuf.length;
  let header;
  if(len < 126){
    header = Buffer.alloc(2); header[0] = 0x80|opcode; header[1] = len;
  } else if(len < 65536){
    header = Buffer.alloc(4); header[0] = 0x80|opcode; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10); header[0] = 0x80|opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payloadBuf]);
}
function wsSendText(socket, str){
  if(socket.destroyed) return;
  try{ socket.write(encodeFrame(Buffer.from(str, 'utf8'), 0x1)); }catch(e){}
}
function wsSendPong(socket, payload){
  try{ socket.write(encodeFrame(payload||Buffer.alloc(0), 0xA)); }catch(e){}
}
function wsClose(socket){
  try{ socket.write(encodeFrame(Buffer.alloc(0), 0x8)); socket.end(); }catch(e){}
}
// consome quantos frames completos existirem no buffer; devolve o resto ainda incompleto
function parseFrames(buffer, onFrame){
  let offset = 0;
  while(true){
    if(buffer.length - offset < 2) break;
    const b0 = buffer[offset], b1 = buffer[offset+1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let pos = offset + 2;
    if(len === 126){
      if(buffer.length - pos < 2) break;
      len = buffer.readUInt16BE(pos); pos += 2;
    } else if(len === 127){
      if(buffer.length - pos < 8) break;
      len = Number(buffer.readBigUInt64BE(pos)); pos += 8;
    }
    let maskKey = null;
    if(masked){
      if(buffer.length - pos < 4) break;
      maskKey = buffer.slice(pos, pos+4); pos += 4;
    }
    if(buffer.length - pos < len) break; // ainda não chegou tudo, espera mais dados
    let payload = buffer.slice(pos, pos+len);
    if(masked){
      const unmasked = Buffer.alloc(len);
      for(let i=0;i<len;i++) unmasked[i] = payload[i] ^ maskKey[i%4];
      payload = unmasked;
    }
    onFrame(opcode, payload);
    offset = pos + len;
  }
  return buffer.slice(offset);
}

/* ---------- Estado do jogo (sala única) ---------- */
const players = new Map();  // id -> {socket,x,y,angle,length,color,name,segs,alive,lastSeen}
const food = new Map();     // id -> {id,x,y,v}
let nextFoodId = 1;

function rand(min,max){ return min+Math.random()*(max-min); }
function randomPointInArena(){
  const a = Math.random()*Math.PI*2;
  const r = Math.sqrt(Math.random())*MAP_RADIUS*0.95;
  return { x: Math.cos(a)*r, y: Math.sin(a)*r };
}
function spawnFoodBatch(n){
  for(let i=0;i<n;i++){
    const p = randomPointInArena();
    const id = 'f'+(nextFoodId++);
    food.set(id, { id, x:p.x, y:p.y, v: rand(1,3) });
  }
}
spawnFoodBatch(FOOD_TARGET);

function publicState(p){
  return { id:p.id, x:p.x, y:p.y, angle:p.angle, length:p.length, color:p.color, name:p.name, segs:p.segs, alive:p.alive };
}
function broadcast(obj, exceptId){
  const msg = JSON.stringify(obj);
  for(const p of players.values()){
    if(p.id === exceptId) continue;
    wsSendText(p.socket, msg);
  }
}

function handleMessage(player, raw){
  let msg;
  try{ msg = JSON.parse(raw); }catch(e){ return; }
  player.lastSeen = Date.now();
  if(msg.type === 'state'){
    if(typeof msg.x === 'number' && isFinite(msg.x)) player.x = msg.x;
    if(typeof msg.y === 'number' && isFinite(msg.y)) player.y = msg.y;
    if(typeof msg.angle === 'number' && isFinite(msg.angle)) player.angle = msg.angle;
    if(typeof msg.length === 'number' && isFinite(msg.length)) player.length = Math.max(0, Math.min(20000, msg.length));
    if(Array.isArray(msg.segs)) player.segs = msg.segs.slice(0,140);
    if(typeof msg.name === 'string') player.name = msg.name.slice(0,14);
    if(typeof msg.color === 'string') player.color = msg.color.slice(0,20);
    player.alive = true;
  } else if(msg.type === 'eat'){
    if(typeof msg.foodId === 'string' && food.has(msg.foodId)){
      food.delete(msg.foodId);
      broadcast({ type:'foodEaten', foodId: msg.foodId });
      if(food.size < FOOD_TARGET){
        const p = randomPointInArena();
        const nid = 'f'+(nextFoodId++);
        const nf = { id:nid, x:p.x, y:p.y, v: rand(1,3) };
        food.set(nid, nf);
        broadcast({ type:'foodSpawn', food: nf });
      }
    }
  } else if(msg.type === 'died'){
    player.alive = false;
    broadcast({ type:'playerDied', id: player.id });
  } else if(msg.type === 'respawn'){
    const p2 = randomPointInArena();
    player.x=p2.x; player.y=p2.y; player.length=20; player.segs=[]; player.alive=true;
  }
}

/* ---------- Servidor HTTP + upgrade pra WebSocket ---------- */
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Servidor do Reino das Serpentes no ar. Jogadores conectados: ' + players.size + '\n');
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if(!key){ socket.destroy(); return; }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + acceptKeyFor(key) + '\r\n\r\n'
  );
  socket.setNoDelay(true);

  const id = 'p'+Math.random().toString(36).slice(2,10);
  const spawn = randomPointInArena();
  const player = {
    id, socket,
    x:spawn.x, y:spawn.y, angle:0, length:20,
    color:'#5fd88a', name:'Cobra', segs:[],
    alive:true, lastSeen: Date.now(),
  };
  players.set(id, player);

  wsSendText(socket, JSON.stringify({
    type:'welcome', id, mapRadius: MAP_RADIUS,
    food: [...food.values()],
    players: [...players.values()].filter(p=>p.id!==id).map(publicState),
  }));
  broadcast({ type:'join', id, name: player.name }, id);

  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    buffer = parseFrames(buffer, (opcode, payload) => {
      if(opcode === 0x1){ handleMessage(player, payload.toString('utf8')); }
      else if(opcode === 0x8){ wsClose(socket); }
      else if(opcode === 0x9){ wsSendPong(socket, payload); }
      // 0xA (pong) e 0x2 (binário) não são usados por este jogo — ignorados
    });
  });
  const cleanup = () => {
    if(!players.has(id)) return;
    players.delete(id);
    broadcast({ type:'leave', id });
  };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
});

setInterval(() => {
  const now = Date.now();
  for(const [id, p] of players){
    if(now - p.lastSeen > IDLE_TIMEOUT_MS){
      try{ p.socket.destroy(); }catch(e){}
      players.delete(id);
      broadcast({ type:'leave', id });
    }
  }
  if(players.size === 0) return;
  const snapshot = [...players.values()].filter(p=>p.alive).map(publicState);
  broadcast({ type:'tick', players: snapshot, count: players.size });
}, TICK_MS);

server.listen(PORT, () => console.log('Servidor do Reino das Serpentes rodando na porta ' + PORT));
