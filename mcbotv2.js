#!/usr/bin/env node
/**
 * Bot para PocketMine-MP
 * Proto 70 (MCPE 0.15.x) y proto 84 (MCPE 0.16.x)
 *
 * Uso: node mc.js <ip> <port> <nombre> <bots> <time> [mensajes] [intervalo_msg]
 *
 * Ejemplos:
 *   node mc.js 127.0.0.1 19132 Bot 1 0
 *   node mc.js 127.0.0.1 19132 Bot 5 60 "Hola!" 3
 *   node mc.js 127.0.0.1 19132 Bot 3 0 "Hola!|Como están?|Bot aquí" 4
 *
 *   time=0 = sin límite (Ctrl+C para parar)
 *   mensajes separados por | para rotar
 */
'use strict';

const dgram  = require('dgram');
const zlib   = require('zlib');
const crypto = require('crypto');

// ─── Argumentos ───────────────────────────────────────────────────────────────
const HOST          = process.argv[2]  || '127.0.0.1';
const PORT          = parseInt(process.argv[3])  || 19132;
const NOMBRE        = process.argv[4]  || 'Bot';
const BOTS          = parseInt(process.argv[5])  || 1;
const TIEMPO        = parseInt(process.argv[6])  || 0;
const MENSAJES_RAW  = process.argv[7]  || 'Hola!';
const MSG_INTERVALO = parseInt(process.argv[8])  || 5;

const MENSAJES = MENSAJES_RAW.split('|').map(m => m.trim()).filter(Boolean);

let botsConectados  = 0;
let botsActivos     = [];
let tiempoTerminado = false;

console.log(`[Master] Servidor  : ${HOST}:${PORT}`);
console.log(`[Master] Bots      : ${BOTS}  Nombre base: "${NOMBRE}"`);
console.log(`[Master] Tiempo    : ${TIEMPO > 0 ? TIEMPO + 's' : 'ilimitado (Ctrl+C para parar)'}`);
console.log(`[Master] Mensajes  : ${MENSAJES.join(' | ')}  cada ${MSG_INTERVALO}s\n`);

// ─── Utilidades ───────────────────────────────────────────────────────────────
function generarNombre(base) {
  const c = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += c[Math.floor(Math.random() * c.length)];
  return `${base}_${s}`;
}

// ─── Writer / Reader ──────────────────────────────────────────────────────────
class W {
  constructor() { this.p = []; }
  u8(v)    { const b=Buffer.alloc(1); b[0]=v&0xff;             this.p.push(b); return this; }
  u16be(v) { const b=Buffer.alloc(2); b.writeUInt16BE(v>>>0);  this.p.push(b); return this; }
  i32be(v) { const b=Buffer.alloc(4); b.writeInt32BE(v|0);     this.p.push(b); return this; }
  u32be(v) { const b=Buffer.alloc(4); b.writeUInt32BE(v>>>0);  this.p.push(b); return this; }
  i32le(v) { const b=Buffer.alloc(4); b.writeInt32LE(v|0);     this.p.push(b); return this; }
  i64be(v) { const b=Buffer.alloc(8); b.writeBigInt64BE(BigInt(v)); this.p.push(b); return this; }
  u64be(v) { const b=Buffer.alloc(8); b.writeBigUInt64BE(BigInt(v)); this.p.push(b); return this; }
  f32be(v) { const b=Buffer.alloc(4); b.writeFloatBE(v);       this.p.push(b); return this; }
  tLE(v)   { const b=Buffer.alloc(3); b[0]=v&0xff; b[1]=(v>>8)&0xff; b[2]=(v>>16)&0xff; this.p.push(b); return this; }
  raw(b)   { this.p.push(Buffer.isBuffer(b)?b:Buffer.from(b)); return this; }
  magic()  { this.p.push(MAGIC); return this; }
  str(s)   { const b=Buffer.from(s,'utf8'); this.u16be(b.length); this.p.push(b); return this; }
  strRaw(b){ this.u16be(b.length); this.p.push(b); return this; }
  // RakNet IP: version(1) + inverted_octets(4) + port(2)
  rakIP(ip, port) {
    this.u8(4);
    ip.split('.').forEach(o => this.u8((~parseInt(o)) & 0xff));
    this.u16be(port);
    return this;
  }
  buf() { return Buffer.concat(this.p); }
}

class R {
  constructor(b) { this.b=b; this.p=0; }
  left()   { return this.b.length - this.p; }
  u8()     { return this.b.readUInt8(this.p++); }
  u16be()  { const v=this.b.readUInt16BE(this.p); this.p+=2; return v; }
  i32be()  { const v=this.b.readInt32BE(this.p);  this.p+=4; return v; }
  u32be()  { const v=this.b.readUInt32BE(this.p); this.p+=4; return v; }
  i64be()  { const v=this.b.readBigInt64BE(this.p); this.p+=8; return v; }
  u64be()  { const v=this.b.readBigUInt64BE(this.p); this.p+=8; return v; }
  f32be()  { const v=this.b.readFloatBE(this.p);  this.p+=4; return v; }
  tLE()    { const v=this.b[this.p]|(this.b[this.p+1]<<8)|(this.b[this.p+2]<<16); this.p+=3; return v; }
  bytes(n) { const v=this.b.slice(this.p,this.p+n); this.p+=n; return v; }
  skip(n)  { this.p+=n; return this; }
  str()    { const n=this.u16be(); return this.bytes(n).toString('utf8'); }
}

const MAGIC = Buffer.from([
  0x00,0xFF,0xFF,0x00,0xFE,0xFE,0xFE,0xFE,
  0xFD,0xFD,0xFD,0xFD,0x12,0x34,0x56,0x78,
]);

// MTU sizes a probar en orden
const MTU_LIST = [1492, 1464, 1400, 1200, 576];

// ─── IDs de paquetes ──────────────────────────────────────────────────────────

// Proto 70 (MCPE 0.15.x) — IDs con prefijo 0x80
const P70 = {
  LOGIN:          0x8f,
  PLAY_STATUS:    0x90,
  DISCONNECT:     0x91,
  BATCH:          0x92,
  TEXT:           0x93,
  START_GAME:     0x95,
  MOVE_PLAYER:    0x9d,
  CHUNK_RADIUS:   0xc9,
};

// Proto 84 (MCPE 0.16.x) — IDs de paquetes DENTRO del batch
// Hay dos variantes según la versión exacta de PocketMine
const P84_A = {   // Versión A: PocketMine-MP 0.16 alpha más antiguo
  LOGIN:          0x01,
  PLAY_STATUS:    0x02,
  DISCONNECT:     0x05,
  RSPACK_INFO:    0x06,
  RSPACK_STACK:   0x07,
  RSPACK_RESP:    0x08,
  TEXT:           0x07,   // en esta variante TEXT y RSPACK_STACK coinciden — conflicto
  START_GAME:     0x09,
  MOVE_PLAYER:    0x10,
  CHUNK_RADIUS:   0x3d,
};

const P84_B = {   // Versión B: PocketMine-MP 0.16 más reciente / estándar Bedrock
  LOGIN:          0x01,
  PLAY_STATUS:    0x02,
  SERVER_HS:      0x03,
  CLIENT_HS:      0x04,
  DISCONNECT:     0x05,
  RSPACK_INFO:    0x06,
  RSPACK_STACK:   0x07,
  RSPACK_RESP:    0x08,
  TEXT:           0x09,
  START_GAME:     0x0b,
  MOVE_PLAYER:    0x13,
  CHUNK_RADIUS:   0x45,
};

// ─── EC Key para JWT ──────────────────────────────────────────────────────────
let ecKey = null;
try { ecKey = crypto.generateKeyPairSync('ec', { namedCurve: 'P-384' }); } catch(e) {}

function pubKeyB64() {
  return ecKey ? ecKey.publicKey.export({ type:'spki', format:'der' }).toString('base64') : 'AAAA';
}
function b64url(data) {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data));
  return b.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}
function derToRaw(der) {
  let o = 2;
  const rLen = der[o+1]; o+=2; const rRaw = der.slice(o, o+rLen); o+=rLen;
  const sLen = der[o+1]; o+=2; const sRaw = der.slice(o, o+sLen);
  const r = Buffer.alloc(48,0), s = Buffer.alloc(48,0);
  const rT = rRaw[0]===0?rRaw.slice(1):rRaw; const sT = sRaw[0]===0?sRaw.slice(1):sRaw;
  rT.copy(r, 48-rT.length); sT.copy(s, 48-sT.length);
  return Buffer.concat([r,s]);
}
function makeJWT(payload) {
  const pub  = pubKeyB64();
  const data = b64url({ alg:'ES384', x5u:pub }) + '.' + b64url(payload);
  if (!ecKey) return data + '.';
  try {
    const der = crypto.createSign('SHA384').update(data).sign(ecKey.privateKey);
    return data + '.' + derToRaw(der).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  } catch(e) { return data + '.'; }
}

// ─── Login Proto 84 ───────────────────────────────────────────────────────────
function buildLogin84(bot) {
  const pub  = pubKeyB64();
  const uuid = '00000000-0000-4000-8000-' + crypto.randomBytes(6).toString('hex');
  const now  = Math.floor(Date.now() / 1000);

  // Chain JWT — identidad del jugador
  const chain = makeJWT({
    extraData: { displayName: bot.nombre, identity: uuid, XUID: '' },
    identityPublicKey: pub,
    nbf: now - 60,
    exp: now + 86400,
  });

  // Skin JWT — datos de skin (8192 bytes vacíos)
  const skin = makeJWT({
    ClientRandomId:   Number(bot.clientId & 0xFFFFFFFFn),
    ServerAddress:    `${HOST}:${PORT}`,
    SkinData:         Buffer.alloc(8192, 0).toString('base64'),
    SkinId:           'Standard_Custom',
    CapeData:         '',
    SkinGeometryName: '',
    SkinGeometry:     '',
    DeviceOS:         1,
    GameVersion:      '0.16.0',
  });

  const chainBuf = Buffer.from(JSON.stringify({ chain: [chain] }), 'utf8');
  const skinBuf  = Buffer.from(skin, 'utf8');

  // Payload descomprimido: [i32le chainLen][chain][i32le skinLen][skin]
  const raw  = new W().i32le(chainBuf.length).raw(chainBuf).i32le(skinBuf.length).raw(skinBuf).buf();
  const comp = zlib.deflateSync(raw, { level: 7 });

  // Paquete LOGIN: [0xfe][0x01][i32be proto][i32be compLen][comp]
  return Buffer.concat([
    Buffer.from([0xfe, 0x01]),
    new W().i32be(84).i32be(comp.length).raw(comp).buf(),
  ]);
}

// ─── Login Proto 70 ───────────────────────────────────────────────────────────
function buildLogin70(bot) {
  return new W()
    .u8(P70.LOGIN)
    .str(bot.nombre)
    .i32be(70).i32be(70)
    .u64be(bot.clientId)
    .raw(crypto.randomBytes(16))
    .str(`${HOST}:${PORT}`)
    .str('')
    .str('Standard_Custom')
    .strRaw(Buffer.alloc(8192, 0))
    .u8(0)
    .buf();
}

// ─── Batch builder ────────────────────────────────────────────────────────────
function buildBatch(pkts, bot) {
  const inner = Buffer.concat(pkts.map(p => {
    const lb = Buffer.alloc(4); lb.writeUInt32BE(p.length); return Buffer.concat([lb, p]);
  }));
  const comp = zlib.deflateSync(inner, { level: 7 });
  if (bot.proto >= 84) {
    // Proto 84: [0xfe][0x06][i32be len][comp]
    return Buffer.concat([Buffer.from([0xfe, 0x06]), new W().i32be(comp.length).raw(comp).buf()]);
  }
  // Proto 70: [0x92][i32be len][comp]
  return new W().u8(P70.BATCH).i32be(comp.length).raw(comp).buf();
}

// ─── RakNet frame sender con almacenamiento para NACK ─────────────────────────
const FRAME_STORE_MAX = 1024;

function _rakFrame(bot, payload, isSplit, splitCount, splitId, splitIdx) {
  if (!bot.sock || bot.isClosing || tiempoTerminado) return;
  const seq = bot.sendSeq++;
  const w   = new W();
  w.u8(0x84).tLE(seq);
  w.u8(isSplit ? 0x70 : 0x60);      // RELIABLE_ORDERED | (split flag)
  w.u16be(payload.length * 8);
  w.tLE(bot.msgIndex++).tLE(bot.orderIndex++).u8(0);
  if (isSplit) { w.u32be(splitCount); w.u16be(splitId); w.u32be(splitIdx); }
  w.raw(payload);
  const buf = w.buf();

  // Guardar para retransmisión NACK
  bot.sentFrames.set(seq, buf);
  if (bot.sentFrames.size > FRAME_STORE_MAX) {
    bot.sentFrames.delete(bot.sentFrames.keys().next().value);
  }
  bot.sock.send(buf, 0, buf.length, PORT, HOST, () => {});
}

function sendReliableOrdered(bot, payload) {
  if (!bot.sock || bot.isClosing || tiempoTerminado) return;
  const MAX = (bot.mtuSize || 1464) - 60;
  if (payload.length <= MAX) { _rakFrame(bot, payload, false, 0, 0, 0); return; }
  const sid = (bot.splitId++) & 0xFFFF;
  const cnt = Math.ceil(payload.length / MAX);
  for (let i = 0; i < cnt; i++) {
    _rakFrame(bot, payload.slice(i * MAX, (i + 1) * MAX), true, cnt, sid, i);
  }
}

function sendGame(bot, pkt) {
  if (!bot.sock || bot.isClosing || tiempoTerminado) return;
  sendReliableOrdered(bot, buildBatch([pkt], bot));
}

// ─── ACK / NACK ───────────────────────────────────────────────────────────────
function sendACK(bot, nums) {
  if (!bot.sock || bot.isClosing) return;
  const sorted = [...new Set(nums)].sort((a,b)=>a-b);
  const recs = [];
  for (let i=0; i<sorted.length; ) {
    let s=sorted[i], e=s;
    while (i+1<sorted.length && sorted[i+1]===sorted[i]+1) { i++; e=sorted[i]; }
    recs.push([s,e]); i++;
  }
  const w = new W().u8(0xC0).u16be(recs.length);
  for (const [s,e] of recs) s===e ? w.u8(1).tLE(s) : w.u8(0).tLE(s).tLE(e);
  const buf = w.buf();
  bot.sock.send(buf, 0, buf.length, PORT, HOST, () => {});
}

function handleNACK(bot, msg) {
  if (!bot.sock || bot.isClosing) return;
  try {
    const r = new R(msg); r.skip(1);
    const cnt = r.u16be();
    for (let i=0; i<cnt; i++) {
      const single = r.u8(); const s = r.tLE(); const e = single ? s : r.tLE();
      for (let seq=s; seq<=e; seq++) {
        const f = bot.sentFrames.get(seq);
        if (f && bot.sock && !bot.isClosing) bot.sock.send(f, 0, f.length, PORT, HOST, ()=>{});
      }
    }
  } catch(e) {}
}

// ─── Paquetes de juego ────────────────────────────────────────────────────────
function getProtoIds(bot) {
  if (bot.proto < 84) return { move: P70.MOVE_PLAYER, text: P70.TEXT, chunk: P70.CHUNK_RADIUS };
  return bot.useVariantA
    ? { move: P84_A.MOVE_PLAYER, text: P84_A.TEXT, chunk: P84_A.CHUNK_RADIUS }
    : { move: P84_B.MOVE_PLAYER, text: P84_B.TEXT, chunk: P84_B.CHUNK_RADIUS };
}

function buildChunkRadius(bot) {
  return new W().u8(getProtoIds(bot).chunk).i32be(8).buf();
}

// entityId(i64) x(f32) y+1.62(f32) z(f32) yaw(f32) headYaw(f32) pitch(f32) mode(u8) onGround(u8)
function buildMovePlayer(bot) {
  const p = bot.pos;
  return new W()
    .u8(getProtoIds(bot).move)
    .i64be(bot.entityId)
    .f32be(p.x).f32be(p.y + 1.62).f32be(p.z)
    .f32be(p.yaw).f32be(p.yaw).f32be(p.pitch)
    .u8(0).u8(1)
    .buf();
}

// type=1(CHAT) source(str) message(str)
function buildChat(bot, msg) {
  return new W().u8(getProtoIds(bot).text).u8(1).str(bot.nombre).str(msg).buf();
}

// Resource pack response: status(u8) packCount(u16)
// status: 1=refused 2=send_packs 3=have_all 4=completed
function buildResourcePackResponse(bot, status) {
  const id = bot.useVariantA ? P84_A.RSPACK_RESP : P84_B.RSPACK_RESP;
  return new W().u8(id).u8(status).u16be(0).buf();
}

// ─── Movimiento libre ─────────────────────────────────────────────────────────
const MOVE_TICK_MS   = 100;
const MOVE_CHANGE_MS = 2500;
const MOVE_STEP      = 0.25;
const MOVE_RANGE     = 80;

function startMovement(bot) {
  if (bot.moveTimer || bot.isClosing) return;
  const ox = bot.pos.x, oz = bot.pos.z;
  let dir = Math.random() * Math.PI * 2;
  let spd = MOVE_STEP;

  bot.dirTimer = setInterval(() => {
    if (bot.isClosing || tiempoTerminado) { clearInterval(bot.dirTimer); return; }
    dir = Math.random() * Math.PI * 2;
    spd = MOVE_STEP * (0.5 + Math.random());
  }, MOVE_CHANGE_MS);

  bot.moveTimer = setInterval(() => {
    if (!bot.spawned || bot.isClosing || tiempoTerminado) {
      clearInterval(bot.moveTimer); clearInterval(bot.dirTimer);
      bot.moveTimer = bot.dirTimer = null; return;
    }
    const nx = bot.pos.x + Math.cos(dir) * spd;
    const nz = bot.pos.z + Math.sin(dir) * spd;
    if ((nx - ox) ** 2 + (nz - oz) ** 2 > MOVE_RANGE ** 2) {
      dir = Math.atan2(oz - bot.pos.z, ox - bot.pos.x);
    } else {
      bot.pos.x = nx; bot.pos.z = nz;
    }
    bot.pos.yaw = ((dir * 180 / Math.PI) + 90 + 360) % 360;
    sendGame(bot, buildMovePlayer(bot));
  }, MOVE_TICK_MS);
}

// ─── Chat continuo ────────────────────────────────────────────────────────────
let msgIdx = 0;

function startChat(bot) {
  if (bot.chatTimer || bot.isClosing) return;
  const delay = Math.floor(Math.random() * MSG_INTERVALO * 1000);
  setTimeout(() => {
    if (bot.isClosing || tiempoTerminado) return;
    const send = () => {
      if (!bot.spawned || bot.isClosing || tiempoTerminado) return;
      const m = MENSAJES[msgIdx % MENSAJES.length]; msgIdx++;
      sendGame(bot, buildChat(bot, m));
      console.log(`[${bot.nombre}] Chat → "${m}"`);
    };
    send();
    bot.chatTimer = setInterval(send, MSG_INTERVALO * 1000);
  }, delay);
}

// ─── Spawn ────────────────────────────────────────────────────────────────────
function onSpawn(bot) {
  if (bot.spawned) return;
  bot.spawned = true;
  botsConectados++;
  botsActivos.push(bot);
  console.log(`[${bot.nombre}] ✓ En juego — pos=(${bot.pos.x.toFixed(1)},${bot.pos.y.toFixed(1)},${bot.pos.z.toFixed(1)}) total=${botsConectados}/${BOTS}`);
  startMovement(bot);
  startChat(bot);
}

// ─── Procesamiento de paquetes de juego ───────────────────────────────────────
function mcpe(bot, data) {
  if (!data || data.length === 0 || bot.isClosing) return;
  const pid = data[0];
  const r   = new R(data); r.skip(1);

  // PLAY_STATUS — proto 70: 0x90, proto 84: 0x02
  if (pid === P70.PLAY_STATUS || pid === 0x02) {
    const st = r.i32be();
    const names = { 0:'Login OK', 1:'Cliente viejo', 2:'Servidor lleno', 3:'Spawneado', 4:'Mundo viejo', 5:'Cliente nuevo' };
    console.log(`[${bot.nombre}] PLAY_STATUS=${st} (${names[st] || '?'})`);
    if (st === 0) {
      // Login aceptado → pedir chunks inmediatamente
      sendGame(bot, buildChunkRadius(bot));
    } else if (st === 1 || st === 2) {
      cerrarBot(bot);
    } else if (st === 3) {
      onSpawn(bot);
    }
    return;
  }

  // RESOURCE_PACK_INFO — 0x06 (proto 84, solo durante negociación)
  // NO responder si ya terminó la negociación o si el servidor usa variante A
  // (en variante A, 0x06 podría ser otro paquete de juego)
  if (pid === 0x06 && bot.proto >= 84 && !bot.resourcePackDone && !bot.useVariantA) {
    console.log(`[${bot.nombre}] Resource pack info → confirmando`);
    sendGame(bot, buildResourcePackResponse(bot, 3)); // STATUS_HAVE_ALL_PACKS
    return;
  }

  // RESOURCE_PACK_STACK — 0x07 (proto 84, solo durante negociación pre-spawn)
  // En variante A: 0x07 = TEXT (chat), NO es resource pack stack
  // Después de spawn: 0x07 son chats de otros jugadores, no responder
  if (pid === 0x07 && bot.proto >= 84 && !bot.resourcePackDone && !bot.useVariantA) {
    console.log(`[${bot.nombre}] Resource pack stack → completado`);
    bot.resourcePackDone = true;
    sendGame(bot, buildResourcePackResponse(bot, 4)); // STATUS_COMPLETED
    return;
  }

  // SERVER_TO_CLIENT_HANDSHAKE — 0x03 (proto 84 con encriptación)
  if (pid === 0x03 && bot.proto >= 84) {
    console.log(`[${bot.nombre}] Server handshake recibido → respondiendo`);
    sendGame(bot, new W().u8(0x04).buf()); // CLIENT_TO_SERVER_HANDSHAKE
    // Re-enviar chunk radius por si acaso
    sendGame(bot, buildChunkRadius(bot));
    return;
  }

  // START_GAME — proto 70: 0x95, proto 84 B: 0x0b, proto 84 A: 0x09
  if (pid === P70.START_GAME || pid === 0x09 || pid === 0x0b || pid === 0x11) {
    // Detectar variante proto 84
    if (bot.proto >= 84) {
      bot.useVariantA = (pid === 0x09);
      console.log(`[${bot.nombre}] START_GAME id=0x${pid.toString(16)} → variante ${bot.useVariantA ? 'A' : 'B'}`);
    }
    try {
      r.i32be();               // seed
      r.u8();                  // dimension
      r.i32be();               // generator type
      r.i32be();               // gamemode
      bot.entityId = r.i64be();
      r.i32be(); r.i32be(); r.i32be();  // spawn X, Y, Z
      bot.pos.x = r.f32be();
      bot.pos.y = r.f32be();
      bot.pos.z = r.f32be();
      console.log(`[${bot.nombre}] START_GAME eid=${bot.entityId} pos=(${bot.pos.x.toFixed(1)},${bot.pos.y.toFixed(1)},${bot.pos.z.toFixed(1)})`);
    } catch(e) {
      console.log(`[${bot.nombre}] START_GAME recibido (sin pos)`);
    }
    // Pedir chunks
    sendGame(bot, buildChunkRadius(bot));
    // Fallback spawn a los 8s por si no llega PLAY_STATUS(3)
    if (!bot.spawnFallback) {
      bot.spawnFallback = setTimeout(() => {
        if (!bot.spawned && !bot.isClosing && !tiempoTerminado) {
          console.log(`[${bot.nombre}] Fallback: forzando spawn`);
          onSpawn(bot);
        }
      }, 8000);
    }
    return;
  }

  // DISCONNECT — proto 70: 0x91, proto 84: 0x05
  if (pid === P70.DISCONNECT || pid === 0x05) {
    let msg = '';
    try { msg = r.str(); } catch(e) {}
    console.log(`[${bot.nombre}] Kick: "${msg || '(sin mensaje)'}"`);
    cerrarBot(bot);
    return;
  }

  // Log de paquetes desconocidos importantes (solo los primeros para no saturar)
  if (!bot._unknownLogged) bot._unknownLogged = {};
  if (!bot._unknownLogged[pid]) {
    bot._unknownLogged[pid] = true;
    const hex = data.slice(0, Math.min(8, data.length)).toString('hex');
    console.log(`[${bot.nombre}] Pkt desconocido: 0x${pid.toString(16).padStart(2,'0')} [${hex}...]`);
  }
}

// ─── Descomprimir batch y procesar paquetes ───────────────────────────────────
function handleBatch(bot, payload) {
  if (bot.isClosing) return;
  try {
    const r       = new R(payload);
    const compLen = r.i32be();
    const comp    = r.bytes(Math.min(compLen, r.left()));
    let inner;
    try       { inner = zlib.inflateSync(comp); }
    catch(e)  { inner = zlib.inflateRawSync(comp); }
    const ir = new R(inner);
    while (ir.left() >= 4) {
      const len = ir.u32be();
      if (len === 0 || len > ir.left()) break;
      const pkt = ir.bytes(len);
      // Proto 84: inner packets pueden tener 0xfe wrapper
      mcpe(bot, (pkt[0] === 0xfe && pkt.length > 1) ? pkt.slice(1) : pkt);
    }
  } catch(e) {}
}

// ─── Procesar payload de RakNet ───────────────────────────────────────────────
function innerPacket(bot, payload) {
  if (!payload || payload.length === 0 || bot.isClosing) return;
  const pid = payload[0];

  // Connected Ping → pong
  if (pid === 0x00) {
    if (payload.length >= 9) {
      const t = payload.readBigInt64BE(1);
      _rakFrame(bot, new W().u8(0x03).i64be(t).i64be(BigInt(Date.now())).buf(), false,0,0,0);
    }
    return;
  }
  if (pid === 0x03) return;                          // Connected Pong
  if (pid === 0x15) { cerrarBot(bot); return; }      // Disconnect Notification
  if (pid === 0x10) { handleServerHandshake(bot, payload); return; } // New Incoming Conn

  // Proto 84: 0xfe + 0x06 = batch
  if (pid === 0xfe) {
    if (payload.length < 2) return;
    const next = payload[1];
    if (next === 0x06) {
      handleBatch(bot, payload.slice(2));
    } else {
      mcpe(bot, payload.slice(1));
    }
    return;
  }

  // Proto 70: 0x92 = batch
  if (pid === P70.BATCH) { handleBatch(bot, payload.slice(1)); return; }

  // Proto 84 batch sin prefijo 0xfe (algunos servidores)
  if (pid === 0x06 && bot.proto >= 84) { handleBatch(bot, payload.slice(1)); return; }

  mcpe(bot, payload);
}

// ─── Parsear data packet RakNet ───────────────────────────────────────────────
function parseDataPkt(bot, msg) {
  if (bot.isClosing) return;
  const r   = new R(msg); r.skip(1);
  const seq = r.tLE();
  bot.ackQueue.push(seq);

  while (r.left() > 0) {
    try {
      const flags    = r.u8();
      const rel      = (flags >> 5) & 7;
      const isSplit  = (flags >> 4) & 1;
      const bits     = r.u16be();
      const blen     = Math.ceil(bits / 8);

      if ([2,3,4,6,7].includes(rel)) r.tLE();         // messageIndex
      if ([1,3,4].includes(rel))     { r.tLE(); r.u8(); } // orderIndex + channel

      let sc=0, si=0, sx=0;
      if (isSplit) { sc=r.u32be(); si=r.u16be(); sx=r.u32be(); }

      const payload = r.bytes(blen);
      if (isSplit) {
        if (!bot.splitMap.has(si)) bot.splitMap.set(si, new Array(sc).fill(null));
        bot.splitMap.get(si)[sx] = payload;
        if (bot.splitMap.get(si).every(x => x !== null)) {
          innerPacket(bot, Buffer.concat(bot.splitMap.get(si)));
          bot.splitMap.delete(si);
        }
      } else {
        innerPacket(bot, payload);
      }
    } catch(e) { break; }
  }
}

// ─── Server Handshake (New Incoming Connection 0x10) ─────────────────────────
function handleServerHandshake(bot, payload) {
  if (bot.isClosing) return;
  const r = new R(payload); r.skip(1);
  let pingTime = 0n;
  try {
    const v = r.u8(); r.skip(v===4?6:18); r.skip(2);
    for (let i=0; i<10; i++) { const x=r.u8(); r.skip(x===4?6:18); }
    pingTime = r.i64be();
  } catch(e) {}

  // Client Handshake (0x13)
  const hw = new W().u8(0x13);
  hw.rakIP(HOST, PORT);
  for (let i=0; i<10; i++) hw.u8(4).u8(0x80).u8(0xFF).u8(0xFF).u8(0xFE).u16be(0);
  hw.i64be(pingTime).i64be(BigInt(Date.now()));
  _rakFrame(bot, hw.buf(), false,0,0,0);

  if (bot.phase === 'HANDSHAKING') {
    bot.phase = 'LOGIN';
    console.log(`[${bot.nombre}] RakNet handshake OK → enviando login (proto ${bot.proto})`);
    setTimeout(() => {
      if (tiempoTerminado || bot.isClosing) return;
      const loginPkt = bot.proto >= 84 ? buildLogin84(bot) : buildLogin70(bot);
      sendReliableOrdered(bot, loginPkt);
    }, 100);
  }
}

// ─── Open Connection Request 1 ────────────────────────────────────────────────
function sendRequest1(bot) {
  if (!bot.sock || bot.isClosing || tiempoTerminado) return;
  const mtu     = MTU_LIST[bot.mtuIdx % MTU_LIST.length];
  bot.mtuSize   = mtu;
  const padding = Math.max(0, mtu - 28 - 1 - 16 - 1); // mtu - UDP_overhead - ID - MAGIC - version
  const buf     = new W().u8(0x05).magic().u8(7).raw(Buffer.alloc(padding, 0)).buf();
  bot.sock.send(buf, 0, buf.length, PORT, HOST, () => {});
}

// ─── Cerrar bot ───────────────────────────────────────────────────────────────
function cerrarBot(bot) {
  if (bot.isClosing) return;
  bot.isClosing = true;
  bot.connected = false;
  bot.spawned   = false;
  clearTimeout(bot.spawnFallback);
  clearTimeout(bot.mtuRetryT);
  clearTimeout(bot.req2RetryT);
  if (bot.moveTimer)         { clearInterval(bot.moveTimer);         bot.moveTimer=null; }
  if (bot.dirTimer)          { clearInterval(bot.dirTimer);          bot.dirTimer=null; }
  if (bot.chatTimer)         { clearInterval(bot.chatTimer);         bot.chatTimer=null; }
  if (bot.keepaliveInterval) { clearInterval(bot.keepaliveInterval); bot.keepaliveInterval=null; }
  if (bot.sock) { try { bot.sock.close(); } catch(e) {} bot.sock=null; }
  console.log(`[${bot.nombre}] Desconectado`);
}

// ─── Iniciar bot ──────────────────────────────────────────────────────────────
function iniciarBot(numero) {
  const bot = {
    id: numero,
    nombre: generarNombre(NOMBRE),
    phase: 'UNCONNECTED',
    clientId: BigInt('0x' + crypto.randomBytes(8).toString('hex')),
    mtuSize: MTU_LIST[0],
    mtuIdx: 0,
    serverGUID: 0n,
    sendSeq: 0, msgIndex: 0, orderIndex: 0, splitId: 0,
    ackQueue: [], splitMap: new Map(), sentFrames: new Map(),
    entityId: 0n,
    proto: 70,
    useVariantA: false,
    resourcePackDone: false,
    pos: { x:0, y:64, z:0, yaw:0, pitch:0 },
    spawned: false, connected: false,
    moveTimer: null, dirTimer: null, chatTimer: null,
    spawnFallback: null, mtuRetryT: null, req2RetryT: null,
    keepaliveInterval: null, isClosing: false,
    _unknownLogged: {},
  };

  bot.sock = dgram.createSocket('udp4');

  bot.sock.on('message', (msg) => {
    if (tiempoTerminado || bot.isClosing || !msg.length) return;
    const pid = msg[0];

    if (pid === 0xC0) return;                        // ACK
    if (pid === 0xA0) { handleNACK(bot, msg); return; } // NACK

    // RakNet data packets
    if (pid >= 0x80 && pid <= 0x8F) {
      parseDataPkt(bot, msg);
      if (bot.ackQueue.length && !bot.isClosing) {
        sendACK(bot, bot.ackQueue); bot.ackQueue = [];
      }
      return;
    }

    // ─── Pre-conexión RakNet ─────────────────────────────────────────────────

    // Open Connection Reply 1 (0x06)
    if (pid === 0x06 && bot.phase === 'CONNECTING_1') {
      // El MTU SIEMPRE está en los últimos 2 bytes del Reply1, sin importar
      // cuántos campos extras tenga el servidor (serverAddress, etc.)
      if (msg.length >= 2) {
        const m = msg.readUInt16BE(msg.length - 2);
        if (m >= 576 && m <= 1500) {
          bot.mtuSize = m;
        } else {
          // Valor inválido → usar 1400 seguro
          bot.mtuSize = 1400;
        }
      }
      // Leer serverGUID (bytes 17-24 del Reply1)
      try {
        if (msg.length >= 25) bot.serverGUID = msg.readBigUInt64BE(17);
      } catch(e) {}

      bot.phase = 'CONNECTING_2';
      clearTimeout(bot.mtuRetryT);
      console.log(`[${bot.nombre}] Reply1 OK → MTU=${bot.mtuSize}, enviando Request2`);
      // Formato estándar RakNet: [serverAddr][mtuSize][clientGUID]
      const req2std = new W().u8(0x07).magic().rakIP(HOST, PORT).u16be(bot.mtuSize).u64be(bot.clientId).buf();
      // Formato alternativo PMMP: [serverAddr][clientGUID][mtuSize]
      const req2alt = new W().u8(0x07).magic().rakIP(HOST, PORT).u64be(bot.clientId).u16be(bot.mtuSize).buf();
      bot.sock.send(req2std, 0, req2std.length, PORT, HOST, () => {});
      bot._req2flip = false;

      // Retry alternando formatos si no llega Reply2
      const sendReq2 = () => {
        if (bot.phase !== 'CONNECTING_2' || bot.isClosing) return;
        bot._req2flip = !bot._req2flip;
        const pkt = bot._req2flip ? req2alt : req2std;
        bot.sock.send(pkt, 0, pkt.length, PORT, HOST, () => {});
        bot.req2RetryT = setTimeout(sendReq2, 2000);
      };
      bot.req2RetryT = setTimeout(sendReq2, 2000);
      return;
    }

    // Open Connection Reply 2 (0x08)
    if (pid === 0x08 && bot.phase === 'CONNECTING_2') {
      clearTimeout(bot.req2RetryT);
      bot.phase = 'HANDSHAKING';
      console.log(`[${bot.nombre}] Reply2 OK → enviando Client Connect`);
      // Client Connect (0x09): clientGUID + timestamp + useSecurity
      _rakFrame(bot, new W().u8(0x09).u64be(bot.clientId).i64be(BigInt(Date.now())).u8(0).buf(), false,0,0,0);
      return;
    }

    // Unconnected Pong (0x1C) → detectar proto y conectar
    if (pid === 0x1C && bot.phase === 'UNCONNECTED') {
      try {
        const r = new R(msg); r.skip(1 + 8 + 8 + 16);
        const motd  = r.bytes(r.u16be()).toString('utf8');
        const parts = motd.split(';');
        if (parts.length >= 3) {
          const p = parseInt(parts[2]);
          if (!isNaN(p) && p > 0) bot.proto = p;
        }
        const srvName = (parts[1] || '?').replace(/\n/g, ' ').replace(/§./g, '').trim().substring(0, 40);
        console.log(`[${bot.nombre}] Servidor: "${srvName}" proto=${bot.proto}`);
      } catch(e) {}
      clearTimeout(bot.mtuRetryT);
      bot.phase = 'CONNECTING_1';
      sendRequest1(bot);
      // Empezar ciclo de retry MTU si no hay Reply1
      scheduleMtuRetry(bot);
      return;
    }
  });

  bot.sock.on('error', () => {});
  bot.sock.bind(0);

  // Ping inicial (detectar protocolo)
  const pingBuf = new W().u8(0x01).i64be(BigInt(Date.now())).magic().u64be(bot.clientId).buf();
  bot.sock.send(pingBuf, 0, pingBuf.length, PORT, HOST, () => {});

  // Reenviar ping cada 500ms hasta obtener respuesta
  let pingCount = 0;
  const pingInterval = setInterval(() => {
    if (bot.phase !== 'UNCONNECTED' || bot.isClosing || tiempoTerminado) {
      clearInterval(pingInterval); return;
    }
    pingCount++;
    if (pingCount >= 4) {
      // Después de 2s sin pong, conectar directo con proto 70
      clearInterval(pingInterval);
      if (bot.phase === 'UNCONNECTED') {
        console.log(`[${bot.nombre}] Sin pong, conectando directo (proto 70)`);
        bot.proto = 70;
        bot.phase = 'CONNECTING_1';
        sendRequest1(bot);
        scheduleMtuRetry(bot);
      }
      return;
    }
    const pb = new W().u8(0x01).i64be(BigInt(Date.now())).magic().u64be(bot.clientId).buf();
    bot.sock.send(pb, 0, pb.length, PORT, HOST, () => {});
  }, 500);

  // Keepalive
  bot.keepaliveInterval = setInterval(() => {
    if (tiempoTerminado || bot.isClosing) { clearInterval(bot.keepaliveInterval); return; }
    if (bot.phase === 'LOGIN' || bot.spawned) {
      _rakFrame(bot, new W().u8(0x00).i64be(BigInt(Date.now())).buf(), false,0,0,0);
    }
  }, 5000);

  return bot;
}

// Ciclo de retry de MTU (si no hay Reply1)
function scheduleMtuRetry(bot) {
  clearTimeout(bot.mtuRetryT);
  bot.mtuRetryT = setTimeout(() => {
    if (bot.phase !== 'CONNECTING_1' || bot.isClosing || tiempoTerminado) return;
    bot.mtuIdx = (bot.mtuIdx + 1) % MTU_LIST.length;
    const mtu = MTU_LIST[bot.mtuIdx];
    console.log(`[${bot.nombre}] Sin Reply1, probando MTU=${mtu}...`);
    sendRequest1(bot);
    scheduleMtuRetry(bot);
  }, 3000);
}

// ─── Tiempo límite ────────────────────────────────────────────────────────────
if (TIEMPO > 0) {
  setTimeout(() => {
    console.log(`\n[Master] ${TIEMPO}s cumplidos. Desconectando ${botsActivos.length} bots...`);
    tiempoTerminado = true;
    botsActivos.forEach(bot => {
      try {
        if (bot.sock && !bot.isClosing) {
          _rakFrame(bot, new W().u8(0x15).buf(), false,0,0,0);
          setTimeout(() => cerrarBot(bot), 200);
        } else cerrarBot(bot);
      } catch(e) { cerrarBot(bot); }
    });
    console.log(`[Master] Total conectados: ${botsConectados}`);
    setTimeout(() => process.exit(0), 1500);
  }, TIEMPO * 1000);
} else {
  console.log('[Master] Sin límite de tiempo. Ctrl+C para detener.\n');
}

// ─── Lanzar bots ─────────────────────────────────────────────────────────────
console.log(`[Master] Lanzando ${BOTS} bot(s)...`);
for (let i = 0; i < BOTS; i++) {
  setTimeout(() => { if (!tiempoTerminado) iniciarBot(i); }, i * 300);
}

process.on('SIGINT', () => {
  console.log('\n[Master] Ctrl+C — cerrando...');
  tiempoTerminado = true;
  botsActivos.forEach(bot => cerrarBot(bot));
  setTimeout(() => process.exit(0), 500);
});
