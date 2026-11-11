import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import express from "express";
import { Server, type Socket } from "socket.io";
import { assertPlayerNameAvailable } from "./player-name.ts";
import {
  chooseBotCard,
  chooseBotColor,
  currentPlayerId,
  drawCards,
  drawForTurn,
  passTurn,
  playCard,
  startGame,
  type GamePlayer,
  type GameState,
} from "./game.ts";
import type {
  AckResponse,
  CardColor,
  ChatMessage,
  PlayerProfile,
  PublicRoom,
  RoomCreateInput,
  RoomJoinInput,
  RoomSettings,
  RoomView,
} from "../shared/types.ts";

interface RoomPlayer extends GamePlayer {
  token: string;
  socketId: string;
  name: string;
  avatar: string;
  ready: boolean;
  connected: boolean;
  isBot: boolean;
  botStyle: "strategist" | "playful" | "bold" | "calm" | null;
}

interface Room {
  code: string;
  name: string;
  isPrivate: boolean;
  passwordHash: string | null;
  hostId: string;
  status: "lobby" | "playing" | "finished";
  settings: RoomSettings;
  players: RoomPlayer[];
  game: GameState | null;
  thinkingBotId?: string;
  chat: ChatMessage[];
  cleanupTimer?: NodeJS.Timeout;
}

interface SocketData {
  playerId?: string;
  roomCode?: string;
  lastChatAt?: number;
}

type Ack = (response: AckResponse) => void;

interface ClientToServerEvents {
  "room:create": (input: RoomCreateInput, ack?: Ack) => void;
  "room:join": (input: RoomJoinInput, ack?: Ack) => void;
  "room:quick": (input: { profile: PlayerProfile; token: string }, ack?: Ack) => void;
  "room:ready": (ack?: Ack) => void;
  "room:start": (ack?: Ack) => void;
  "game:play": (input: { cardId: string; chosenColor?: CardColor }, ack?: Ack) => void;
  "game:draw": (ack?: Ack) => void;
  "game:pass": (ack?: Ack) => void;
  "game:uno": (ack?: Ack) => void;
  "game:catch": (targetId: string, ack?: Ack) => void;
  "room:chat": (text: string, ack?: Ack) => void;
  "room:replay": (ack?: Ack) => void;
  "room:leave": () => void;
}

interface ServerToClientEvents {
  "rooms:list": (rooms: PublicRoom[]) => void;
  "room:update": (room: RoomView) => void;
  "room:chat": (messages: ChatMessage[]) => void;
  "room:error": (message: string) => void;
}

interface InterServerEvents {}
type ArenaSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

const app = express();
const httpServer = createServer(app);
const io = new Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(httpServer, {
  path: "/uno/socket.io",
  cors: { origin: process.env.ALLOWED_ORIGIN?.split(",") ?? true },
  maxHttpBufferSize: 1e5,
});
const rooms = new Map<string, Room>();
const botTurnTimers = new Map<string, NodeJS.Timeout>();
const passwordAttempts = new Map<string, { count: number; resetAt: number }>();
const PORT = Number(process.env.SERVER_PORT?.trim() || process.env.PORT?.trim() || 80);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65_535) {
  throw new Error(`Porta inválida: ${process.env.SERVER_PORT ?? process.env.PORT}. Use uma porta entre 1 e 65535.`);
}

function deriveKey(password: string, salt: string, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, length, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function localNetworkAddress(): string | null {
  const addresses = Object.values(networkInterfaces()).flatMap((items) => items ?? []);
  const ipv4 = addresses.filter((item) => item.family === "IPv4" && !item.internal);
  return ipv4.find(({ address }) =>
    /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(address),
  )?.address ?? ipv4[0]?.address ?? null;
}

app.get("/api/network", (_request, response) => response.json({ address: localNetworkAddress() }));

function cleanText(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function profileFrom(input: PlayerProfile): PlayerProfile {
  const name = cleanText(input?.name, 20);
  if (!name) throw new Error("Escolha um apelido antes de continuar.");
  return { name, avatar: cleanText(input?.avatar, 8) || "fox" };
}

function normalizeSettings(input: RoomSettings): RoomSettings {
  const solo = Boolean(input?.solo);
  return {
    maxPlayers: Math.min(10, Math.max(2, Number(input?.maxPlayers) || 4)),
    startingCards: Math.min(10, Math.max(4, Number(input?.startingCards) || 7)),
    turnSeconds: Math.min(120, Math.max(15, Number(input?.turnSeconds) || 45)),
    public: solo ? false : Boolean(input?.public),
    allowStacking: Boolean(input?.allowStacking),
    solo,
  };
}

function makeRoomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(randomBytes(6), (byte) => alphabet[byte % alphabet.length]).join("");
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${(await deriveKey(password, salt, 64)).toString("hex")}`;
}

async function checkPassword(password: string, stored: string): Promise<boolean> {
  const separator = stored.indexOf(":");
  if (separator < 0) return false;
  const expected = Buffer.from(stored.slice(separator + 1), "hex");
  const actual = await deriveKey(password, stored.slice(0, separator), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function publicRooms(): PublicRoom[] {
  return [...rooms.values()]
    .filter((room) => !room.isPrivate && !room.settings.solo && room.status === "lobby" && room.players.length < room.settings.maxPlayers)
    .map((room) => ({
      code: room.code,
      name: room.name,
      players: room.players.filter((player) => !player.isBot).length,
      maxPlayers: room.settings.maxPlayers,
      status: room.status,
    }));
}

function deleteRoom(code: string): void {
  const room = rooms.get(code);
  if (room?.cleanupTimer) clearTimeout(room.cleanupTimer);
  const timer = botTurnTimers.get(code);
  if (timer) clearTimeout(timer);
  botTurnTimers.delete(code);
  rooms.delete(code);
  io.emit("rooms:list", publicRooms());
}

function addSystemMessage(room: Room, text: string): void {
  room.chat.push({ id: randomUUID(), sender: "UNO ARENA", avatar: "panda", text, time: Date.now(), system: true });
  room.chat = room.chat.slice(-100);
}

function addBotMessage(room: Room, bot: RoomPlayer, text: string): void {
  room.chat.push({ id: randomUUID(), sender: bot.name, avatar: bot.avatar, text, time: Date.now() });
  room.chat = room.chat.slice(-100);
}

function roomView(room: Room, recipient: RoomPlayer): RoomView {
  const game = room.game;
  return {
    code: room.code,
    name: room.name,
    isPrivate: room.isPrivate,
    hostId: room.hostId,
    status: room.status,
    settings: room.settings,
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      avatar: player.avatar,
      ready: player.ready,
      connected: player.connected,
      cardCount: player.hand.length,
      hand: player.id === recipient.id ? player.hand : [],
      isHost: player.id === room.hostId,
      isBot: player.isBot,
      isThinking: room.thinkingBotId === player.id,
      botStyle: player.botStyle,
    })),
    game: game ? {
      topCard: (() => {
        const { color, value } = game.discard.at(-1)!;
        return { color, value };
      })(),
      activeColor: game.activeColor,
      currentPlayerId: currentPlayerId(room.players, game),
      direction: game.direction,
      turnEndsAt: game.turnEndsAt,
      winnerId: game.winnerId,
      drawCount: game.drawCount,
      canPass: game.hasDrawn && currentPlayerId(room.players, game) === recipient.id,
      drawnCardId: game.hasDrawn && currentPlayerId(room.players, game) === recipient.id ? game.drawnCardId : null,
      unoPendingId: game.unoPendingId,
      recentAction: game.recentAction,
      lastEffect: game.lastEffect,
    } : null,
    chat: room.chat.slice(-60),
    myPlayerId: recipient.id,
  };
}

function emitRoom(room: Room): void {
  scheduleBotTurn(room);
  for (const player of room.players) {
    if (!player.connected || player.isBot) continue;
    io.sockets.sockets.get(player.socketId)?.emit("room:update", roomView(room, player));
  }
  io.emit("rooms:list", publicRooms());
}

function addPlayerToSocket(socket: ArenaSocket, room: Room, player: RoomPlayer): void {
  const priorSocket = io.sockets.sockets.get(player.socketId);
  if (priorSocket && priorSocket.id !== socket.id) {
    priorSocket.leave(room.code);
    priorSocket.data.playerId = undefined;
    priorSocket.data.roomCode = undefined;
  }
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  room.cleanupTimer = undefined;
  player.socketId = socket.id;
  player.connected = true;
  socket.data.playerId = player.id;
  socket.data.roomCode = room.code;
  socket.join(room.code);
}

function roomFor(socket: ArenaSocket): { room: Room; player: RoomPlayer } {
  const room = socket.data.roomCode ? rooms.get(socket.data.roomCode) : undefined;
  const player = room?.players.find((entry) => entry.id === socket.data.playerId);
  if (!room || !player || player.isBot) throw new Error("Você não está em uma sala.");
  return { room, player };
}

function sendError(socket: ArenaSocket, ack: Ack | undefined, error: unknown): void {
  const message = error instanceof Error ? error.message : "Não foi possível concluir essa ação.";
  if (ack) ack({ ok: false, error: message });
  else socket.emit("room:error", message);
}

function withAck(socket: ArenaSocket, ack: Ack | undefined, action: () => void): void {
  try {
    action();
    ack?.({ ok: true });
  } catch (error) {
    sendError(socket, ack, error);
  }
}

async function createRoom(socket: ArenaSocket, input: RoomCreateInput): Promise<Room> {
  const profile = profileFrom(input?.profile);
  if (typeof input?.token !== "string" || input.token.length < 16 || input.token.length > 128) {
    throw new Error("Sessão inválida. Atualize a página e tente novamente.");
  }
  const settings = normalizeSettings(input.settings);
  const name = cleanText(input.name, 32) || (settings.solo ? "Partida solo" : `${profile.name} — sala`);
  const password = cleanText(input.password, 64);
  if (!settings.public && !settings.solo && !password) throw new Error("Defina uma senha para a sala privada.");
  let code = makeRoomCode();
  while (rooms.has(code)) code = makeRoomCode();
  const player: RoomPlayer = {
    id: randomUUID(),
    token: input.token,
    socketId: socket.id,
    name: profile.name,
    avatar: profile.avatar,
    ready: true,
    connected: true,
    isBot: false,
    botStyle: null,
    hand: [],
  };
  const room: Room = {
    code,
    name,
    isPrivate: !settings.public,
    passwordHash: password && !settings.solo ? await hashPassword(password) : null,
    hostId: player.id,
    status: "lobby",
    settings,
    players: [player],
    game: null,
    chat: [],
  };
  rooms.set(code, room);
  addPlayerToSocket(socket, room, player);
  addSystemMessage(room, `${profile.name} criou a sala.`);
  emitRoom(room);
  return room;
}

async function joinRoom(socket: ArenaSocket, input: RoomJoinInput): Promise<Room> {
  const code = cleanText(input?.code, 40).toUpperCase().match(/[A-Z0-9]{6}/)?.[0] ?? "";
  const room = rooms.get(code);
  if (!room) throw new Error("Sala não encontrada. Confira o código e tente novamente.");
  const profile = profileFrom(input?.profile);
  if (typeof input?.token !== "string" || input.token.length < 16 || input.token.length > 128) {
    throw new Error("Sessão inválida. Atualize a página e tente novamente.");
  }
  let player = room.players.find((entry) => entry.token === input.token);
  assertPlayerNameAvailable(profile.name, room.players, player?.id);
  if (!player) {
    if (room.settings.solo) throw new Error("Esta partida solo não aceita outros jogadores.");
    if (room.status !== "lobby") throw new Error("A partida já começou.");
    if (room.players.length >= room.settings.maxPlayers) throw new Error("A sala está cheia.");
    if (room.passwordHash) {
      const key = `${socket.handshake.address}:${room.code}`;
      const now = Date.now();
      const previous = passwordAttempts.get(key);
      if (previous && previous.resetAt > now && previous.count >= 8) {
        throw new Error("Muitas tentativas de senha. Aguarde um minuto.");
      }
      const attempt = previous && previous.resetAt > now ? previous : { count: 0, resetAt: now + 60_000 };
      attempt.count += 1;
      passwordAttempts.set(key, attempt);
      if (!(await checkPassword(cleanText(input.password, 64), room.passwordHash))) throw new Error("Senha incorreta.");
      passwordAttempts.delete(key);
    }
    if (room.status !== "lobby" || room.players.length >= room.settings.maxPlayers) throw new Error("A sala está cheia.");
    player = {
      id: randomUUID(),
      token: input.token,
      socketId: socket.id,
      name: profile.name,
      avatar: profile.avatar,
      ready: false,
      connected: true,
      isBot: false,
      botStyle: null,
      hand: [],
    };
    room.players.push(player);
    addSystemMessage(room, `${player.name} entrou na sala.`);
  } else {
    player.name = profile.name;
    player.avatar = profile.avatar;
    addSystemMessage(room, `${player.name} reconectou.`);
  }
  addPlayerToSocket(socket, room, player);
  emitRoom(room);
  return room;
}

function finishIfWon(room: Room): void {
  if (!room.game?.winnerId) return;
  room.status = "finished";
  const winner = room.players.find((player) => player.id === room.game?.winnerId);
  room.game.recentAction = `${winner?.name ?? "Um jogador"} venceu a partida!`;
  addSystemMessage(room, `${winner?.name ?? "Um jogador"} venceu!`);
}

type BotStyle = NonNullable<RoomPlayer["botStyle"]>;

const BOT_PERSONAS: Array<{
  name: string;
  avatar: string;
  style: BotStyle;
  thinking: string[];
  plays: string[];
  draws: string[];
}> = [
  {
    name: "Nina",
    avatar: "fox",
    style: "strategist",
    thinking: ["Nina está contando as possibilidades", "Nina está pensando na próxima jogada"],
    plays: ["Jogada calculada!", "Essa carta estava guardada para a hora certa."],
    draws: ["Nina está reorganizando a estratégia.", "Tudo bem, às vezes o baralho surpreende."],
  },
  {
    name: "Theo",
    avatar: "panda",
    style: "playful",
    thinking: ["Theo está escolhendo uma carta com estilo", "Theo está pensando... e fazendo suspense"],
    plays: ["Toma essa!", "Agora a partida ficou interessante!"],
    draws: ["Theo comprou uma carta. O suspense continua!", "O baralho ganhou essa rodada."],
  },
  {
    name: "Luna",
    avatar: "frog",
    style: "bold",
    thinking: ["Luna está preparando uma surpresa", "Luna está procurando a jogada perfeita"],
    plays: ["Luna atacou com tudo!", "Essa mesa vai virar agora!"],
    draws: ["Luna comprou, mas não perdeu a confiança.", "A próxima jogada vem forte!"],
  },
  {
    name: "Caio",
    avatar: "tiger",
    style: "calm",
    thinking: ["Caio está analisando a mesa", "Caio está decidindo com calma"],
    plays: ["Boa jogada.", "Caio manteve a calma e jogou."],
    draws: ["Caio comprou uma carta e segue tranquilo.", "Sem pressa. A partida continua."],
  },
  {
    name: "Maya",
    avatar: "octopus",
    style: "playful",
    thinking: ["Maya está preparando uma reviravolta", "Maya está pensando com todos os tentáculos"],
    plays: ["Surpresa!", "Maya virou o jogo!"],
    draws: ["Maya comprou uma carta. Tentando outra estratégia!", "O baralho pregou uma peça na Maya."],
  },
  {
    name: "Ravi",
    avatar: "unicorn",
    style: "strategist",
    thinking: ["Ravi está estudando as cores", "Ravi está calculando o próximo passo"],
    plays: ["Plano executado!", "Ravi já estava esperando por essa jogada."],
    draws: ["Ravi comprou uma carta e recalculou a rota.", "Às vezes, a melhor jogada é esperar."],
  },
  {
    name: "Bia",
    avatar: "dragon",
    style: "bold",
    thinking: ["Bia está juntando coragem para a próxima jogada", "Bia está pronta para surpreender"],
    plays: ["Bia chegou chegando!", "Essa foi direto para a mesa!"],
    draws: ["Bia comprou uma carta e já está de olho na revanche.", "O próximo turno vai ser diferente!"],
  },
  {
    name: "Noah",
    avatar: "bear",
    style: "calm",
    thinking: ["Noah está pensando na melhor cor", "Noah está observando a partida"],
    plays: ["Noah fez sua jogada.", "Noah escolheu o momento certo."],
    draws: ["Noah comprou uma carta. Ainda tem jogo!", "Uma carta a mais, novas possibilidades."],
  },
  {
    name: "Zeca",
    avatar: "panda",
    style: "playful",
    thinking: ["Zeca está pensando... sem espiar a mão!", "Zeca está fazendo suspense"],
    plays: ["Zeca aprontou mais uma!", "Quem diria? Zeca tinha essa carta!"],
    draws: ["Zeca comprou uma carta. Faz parte!", "Essa foi por pouco, Zeca!"],
  },
];

function personaLine(player: RoomPlayer, kind: "thinking" | "plays" | "draws"): string {
  const persona = BOT_PERSONAS.find((entry) => entry.name === player.name.replace(/^IA /, ""));
  const lines = persona?.[kind] ?? ["Está pensando..."];
  return lines[Math.floor(Math.random() * lines.length)];
}

function runBotTurn(code: string, botId: string): void {
  botTurnTimers.delete(code);
  const room = rooms.get(code);
  const game = room?.game;
  const bot = room?.players.find((player) => player.id === botId && player.isBot);
  if (!room || room.status !== "playing" || !game || !bot || currentPlayerId(room.players, game) !== bot.id) return;
  room.thinkingBotId = undefined;
  try {
    const card = chooseBotCard(bot.hand, game, room.settings.allowStacking);
    if (card) {
      const chosenColor = card.color === "wild"
        ? chooseBotColor(bot.hand.filter((held) => held.id !== card.id))
        : undefined;
      playCard(room.players, game, bot.id, card.id, chosenColor, room.settings.turnSeconds, room.settings.allowStacking);
      addBotMessage(room, bot, `${personaLine(bot, "plays")} (${card.value === "draw4" ? "+4" : card.value === "draw2" ? "+2" : String(card.value)}).`);
      finishIfWon(room);
      if (!game.winnerId && bot.hand.length === 1) {
        game.unoPendingId = null;
        game.recentAction = `${bot.name} declarou UNO!`;
      }
    } else if (game.hasDrawn) {
      passTurn(room.players, game, bot.id, room.settings.turnSeconds);
      game.unoPendingId = null;
      game.recentAction = `${bot.name} passou a vez.`;
      addSystemMessage(room, game.recentAction);
    } else {
      const originalIndex = game.currentIndex;
      const cards = drawForTurn(room.players, game, bot.id, room.settings.turnSeconds);
      if (game.currentIndex === originalIndex && game.hasDrawn) {
        const drawnCard = chooseBotCard(bot.hand, game, room.settings.allowStacking);
        if (drawnCard) {
          const chosenColor = drawnCard.color === "wild"
            ? chooseBotColor(bot.hand.filter((held) => held.id !== drawnCard.id))
            : undefined;
          playCard(room.players, game, bot.id, drawnCard.id, chosenColor, room.settings.turnSeconds, room.settings.allowStacking);
          finishIfWon(room);
          if (!game.winnerId && bot.hand.length === 1) game.unoPendingId = null;
        } else {
          passTurn(room.players, game, bot.id, room.settings.turnSeconds);
        }
      }
      if (cards.length) {
        game.recentAction = `${bot.name} comprou ${cards.length} carta(s).`;
        addBotMessage(room, bot, personaLine(bot, "draws"));
      }
    }
    emitRoom(room);
  } catch (error) {
    console.error(`Erro no turno da IA da sala ${code}:`, error);
    room.thinkingBotId = undefined;
    game.recentAction = `${bot.name} teve um problema ao jogar. Tentando novamente…`;
    game.turnEndsAt = Date.now() + 5_000;
    emitRoom(room);
  }
}

function scheduleBotTurn(room: Room): void {
  const game = room.game;
  if (!game || room.status !== "playing") {
    room.thinkingBotId = undefined;
    return;
  }
  const player = room.players[game.currentIndex];
  if (!player?.isBot) {
    room.thinkingBotId = undefined;
    const timer = botTurnTimers.get(room.code);
    if (timer) clearTimeout(timer);
    botTurnTimers.delete(room.code);
    return;
  }
  if (botTurnTimers.has(room.code)) return;
  room.thinkingBotId = player.id;
  game.recentAction = personaLine(player, "thinking");
  const thinkingDelay = 1_800 + Math.floor(Math.random() * 2_400);
  botTurnTimers.set(room.code, setTimeout(() => runBotTurn(room.code, player.id), thinkingDelay));
}

function leaveRoom(socket: ArenaSocket, disconnected = false): void {
  const code = socket.data.roomCode;
  const playerId = socket.data.playerId;
  const room = code ? rooms.get(code) : undefined;
  const player = room?.players.find((entry) => entry.id === playerId);
  if (!code || !playerId || !room || !player || player.isBot) return;
  player.connected = false;
  player.ready = false;
  socket.leave(code);
  socket.data.roomCode = undefined;
  socket.data.playerId = undefined;
  if (room.status === "lobby" && !disconnected) room.players = room.players.filter((entry) => entry.id !== player.id);
  if (room.players.length === 0) return deleteRoom(code);
  if (room.hostId === player.id) {
    const nextHost = room.players.find((entry) => entry.connected && !entry.isBot);
    if (nextHost) room.hostId = nextHost.id;
  }
  addSystemMessage(room, `${player.name} saiu da sala.`);
  emitRoom(room);
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  if (!room.players.some((entry) => entry.connected && !entry.isBot)) {
    room.cleanupTimer = setTimeout(() => {
      if (room.status === "lobby") {
        room.players = room.players.filter((entry) => entry.connected && !entry.isBot);
        if (room.players.length) {
          room.hostId = room.players[0].id;
          emitRoom(room);
        } else deleteRoom(room.code);
      } else deleteRoom(room.code);
    }, 180_000);
  }
}

io.on("connection", (socket) => {
  socket.emit("rooms:list", publicRooms());

  socket.on("room:create", (input, ack) => {
    void createRoom(socket, input)
      .then((room) => ack?.({ ok: true, room: roomView(room, room.players[0]) }))
      .catch((error: unknown) => sendError(socket, ack, error));
  });

  socket.on("room:join", (input, ack) => {
    void joinRoom(socket, input)
      .then((room) => {
        const player = room.players.find((entry) => entry.id === socket.data.playerId);
        if (!player) throw new Error("Não foi possível entrar na sala.");
        ack?.({ ok: true, room: roomView(room, player) });
      })
      .catch((error: unknown) => sendError(socket, ack, error));
  });

  socket.on("room:quick", (input, ack) => {
    const room = [...rooms.values()].find((candidate) =>
      !candidate.isPrivate && !candidate.settings.solo && candidate.status === "lobby" &&
      candidate.players.length < candidate.settings.maxPlayers,
    );
    if (!room) return sendError(socket, ack, new Error("Nenhuma sala pública disponível. Crie uma sala e convide seus amigos."));
    void joinRoom(socket, { code: room.code, profile: input.profile, token: input.token })
      .then((joined) => {
        const player = joined.players.find((entry) => entry.id === socket.data.playerId);
        ack?.({ ok: true, room: player ? roomView(joined, player) : undefined });
      })
      .catch((error: unknown) => sendError(socket, ack, error));
  });

  socket.on("room:ready", (ack) => withAck(socket, ack, () => {
    const { room, player } = roomFor(socket);
    if (room.status !== "lobby" || room.settings.solo) throw new Error("Não é possível alterar o status desta sala.");
    if (player.id !== room.hostId) player.ready = !player.ready;
    emitRoom(room);
  }));

  socket.on("room:start", (ack) => withAck(socket, ack, () => {
    const { room, player } = roomFor(socket);
    if (player.id !== room.hostId) throw new Error("Somente o anfitrião pode iniciar a partida.");
    if (room.status !== "lobby") throw new Error("A partida já começou.");
    if (room.settings.solo) {
      if (room.players.some((entry) => entry.isBot)) throw new Error("A partida solo já foi preparada.");
      const names = ["Nina", "Theo", "Luna", "Caio", "Maya", "Ravi", "Bia", "Noah", "Zeca"];
      for (let index = 0; index < room.settings.maxPlayers - 1; index += 1) {
        room.players.push({
          id: randomUUID(),
          token: randomUUID(),
          socketId: "",
          name: names[index],
          avatar: BOT_PERSONAS[index].avatar,
          ready: true,
          connected: true,
          isBot: true,
          botStyle: BOT_PERSONAS[index].style,
          hand: [],
        });
      }
    } else {
      if (room.players.length < 2) throw new Error("A sala precisa de pelo menos 2 jogadores.");
      if (room.players.some((entry) => !entry.connected || !entry.ready)) {
        throw new Error("Todos os jogadores conectados precisam ficar prontos.");
      }
    }
    room.game = startGame(room.players, room.settings.startingCards, room.settings.turnSeconds);
    room.status = "playing";
    addSystemMessage(room, room.settings.solo
      ? `Partida solo iniciada contra ${room.players.length - 1} ${room.players.length === 2 ? "adversário de IA" : "adversários de IA"}.`
      : "A partida começou. Boa sorte!");
    emitRoom(room);
  }));

  socket.on("game:play", (input, ack) => withAck(socket, ack, () => {
    const { room, player } = roomFor(socket);
    if (!room.game || room.status !== "playing") throw new Error("Não há uma partida em andamento.");
    const card = playCard(room.players, room.game, player.id, input?.cardId, input?.chosenColor, room.settings.turnSeconds, room.settings.allowStacking);
    addSystemMessage(room, `${player.name} jogou ${card.value === "draw4" ? "+4" : card.value === "draw2" ? "+2" : String(card.value)}.`);
    finishIfWon(room);
    if (room.game.unoPendingId === player.id) {
      room.game.recentAction = `${player.name} ficou com uma carta. Declare UNO!`;
    }
    emitRoom(room);
  }));

  socket.on("game:draw", (ack) => withAck(socket, ack, () => {
    const { room, player } = roomFor(socket);
    if (!room.game || room.status !== "playing") throw new Error("Não há uma partida em andamento.");
    const penalty = room.game.drawCount > 0;
    const cards = drawForTurn(room.players, room.game, player.id, room.settings.turnSeconds);
    room.game.recentAction = penalty
      ? `${player.name} comprou ${cards.length} cartas da penalidade.`
      : `${player.name} comprou uma carta.`;
    addSystemMessage(room, room.game.recentAction);
    emitRoom(room);
  }));

  socket.on("game:pass", (ack) => withAck(socket, ack, () => {
    const { room, player } = roomFor(socket);
    if (!room.game || room.status !== "playing") throw new Error("Não há uma partida em andamento.");
    passTurn(room.players, room.game, player.id, room.settings.turnSeconds);
    room.game.unoPendingId = null;
    emitRoom(room);
  }));

  socket.on("game:uno", (ack) => withAck(socket, ack, () => {
    const { room, player } = roomFor(socket);
    if (!room.game || room.game.unoPendingId !== player.id || player.hand.length !== 1) {
      throw new Error("Você só pode declarar UNO quando estiver com uma carta.");
    }
    room.game.unoPendingId = null;
    room.game.recentAction = `${player.name} declarou UNO!`;
    emitRoom(room);
  }));

  socket.on("game:catch", (targetId, ack) => withAck(socket, ack, () => {
    const { room, player } = roomFor(socket);
    const game = room.game;
    if (!game || !game.unoPendingId || game.unoPendingId === player.id || game.unoPendingId !== targetId) {
      throw new Error("Não há uma declaração de UNO para contestar.");
    }
    const target = room.players.find((entry) => entry.id === targetId);
    if (!target || target.hand.length !== 1) throw new Error("A oportunidade de contestar acabou.");
    target.hand.push(...drawCards(game, 2));
    game.unoPendingId = null;
    game.recentAction = `${target.name} esqueceu o UNO e comprou 2 cartas.`;
    addSystemMessage(room, game.recentAction);
    emitRoom(room);
  }));

  socket.on("room:chat", (raw, ack) => withAck(socket, ack, () => {
    const { room, player } = roomFor(socket);
    const text = cleanText(raw, 240);
    if (!text) throw new Error("Digite uma mensagem antes de enviar.");
    const now = Date.now();
    if (now - (socket.data.lastChatAt ?? 0) < 700) throw new Error("Espere um instante antes de enviar outra mensagem.");
    socket.data.lastChatAt = now;
    room.chat.push({ id: randomUUID(), sender: player.name, avatar: player.avatar, text, time: now });
    room.chat = room.chat.slice(-100);
    io.to(room.code).emit("room:chat", room.chat);
    emitRoom(room);
  }));

  socket.on("room:replay", (ack) => withAck(socket, ack, () => {
    const { room, player } = roomFor(socket);
    if (player.id !== room.hostId) throw new Error("Somente o anfitrião pode iniciar outra rodada.");
    if (room.status !== "finished") throw new Error("A partida ainda não terminou.");
    room.players = room.players.filter((entry) => !entry.isBot);
    for (const entry of room.players) {
      entry.hand = [];
      entry.ready = entry.id === room.hostId;
    }
    room.game = null;
    room.status = "lobby";
    addSystemMessage(room, "Uma nova rodada está pronta.");
    emitRoom(room);
  }));

  socket.on("room:leave", () => leaveRoom(socket));
  socket.on("disconnect", () => leaveRoom(socket, true));
});

setInterval(() => {
  for (const room of rooms.values()) {
    const game = room.game;
    if (!game || room.status !== "playing" || game.turnEndsAt > Date.now()) continue;
    const playerId = currentPlayerId(room.players, game);
    try {
      if (game.hasDrawn) passTurn(room.players, game, playerId, room.settings.turnSeconds);
      else drawForTurn(room.players, game, playerId, room.settings.turnSeconds);
      game.recentAction = "O tempo acabou. A vez foi atualizada automaticamente.";
      emitRoom(room);
    } catch (error) {
      console.error(`Erro ao encerrar turno da sala ${room.code}:`, error);
      game.turnEndsAt = Date.now() + 5_000;
    }
  }
}, 1_000).unref();

if (existsSync("dist")) {
  app.use("/uno", express.static("dist"));
  app.use(express.static("dist"));
  app.use((_request, response) => response.sendFile("index.html", { root: "dist" }));
}

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`UNO ARENA disponível em http://localhost:${PORT}`);
});
