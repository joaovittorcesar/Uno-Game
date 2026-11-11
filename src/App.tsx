import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { io, type Socket } from "socket.io-client";
import type {
  AckResponse,
  Card,
  CardColor,
  ChatMessage,
  GameEffect,
  PlayerProfile,
  PublicRoom,
  RoomCreateInput,
  RoomJoinInput,
  RoomSettings,
  RoomView,
} from "../shared/types.ts";

const AVATARS = ["fox", "panda", "frog", "tiger", "octopus", "unicorn", "dragon", "bear"];
const AVATAR_NAMES = ["Raposa", "Panda", "Sapo", "Tigre", "Polvo", "Unicórnio", "Dragão", "Urso"];
const COLORS: CardColor[] = ["red", "yellow", "green", "blue"];
const COLOR_NAMES: Record<CardColor, string> = {
  red: "Vermelho",
  yellow: "Amarelo",
  green: "Verde",
  blue: "Azul",
};
const DEFAULT_SETTINGS: RoomSettings = {
  maxPlayers: 4,
  startingCards: 7,
  turnSeconds: 45,
  public: true,
  allowStacking: false,
  solo: false,
};

function readStorage<T>(key: string, fallback: T): T {
  try {
    const data = localStorage.getItem(key);
    return data ? (JSON.parse(data) as T) : fallback;
  } catch {
    return fallback;
  }
}

function playerToken(): string {
  let token = localStorage.getItem("uno-token");
  if (!token) {
    token = Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    localStorage.setItem("uno-token", token);
  }
  return token;
}

function label(value: Card["value"]): string {
  if (typeof value === "number") return String(value);
  return { skip: "⊘", reverse: "⇄", draw2: "+2", draw4: "+4", wild: "★" }[value];
}

function playable(card: Card, room: RoomView): boolean {
  const game = room.game;
  if (!game) return false;
  const hand = room.players.find((player) => player.id === room.myPlayerId)?.hand ?? [];
  if (
    card.value === "draw4" &&
    hand.some((held) => held.id !== card.id && held.color === game.activeColor)
  ) return false;
  if (game.drawnCardId) return card.id === game.drawnCardId;
  if (game.drawCount > 0) {
    return room.settings.allowStacking && (card.value === "draw2" || card.value === "draw4");
  }
  return card.color === "wild" || card.color === game.activeColor || card.value === game.topCard.value;
}

function timeText(timestamp: number): string {
  return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(timestamp);
}

function App() {
  const [profile, setProfile] = useState<PlayerProfile>(() =>
    readStorage("uno-profile", { name: "Jogador", avatar: AVATARS[0] }),
  );
  const [settings, setSettings] = useState<RoomSettings>(() => ({
    ...DEFAULT_SETTINGS,
    ...readStorage<Partial<RoomSettings>>("uno-settings", {}),
  }));
  const [room, setRoom] = useState<RoomView | null>(null);
  const [publicRooms, setPublicRooms] = useState<PublicRoom[]>([]);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [dialog, setDialog] = useState<"create" | "join" | "profile" | "rules" | null>(null);
  const [roomName, setRoomName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [wildCard, setWildCard] = useState<Card | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [unreadChat, setUnreadChat] = useState(0);
  const [chatText, setChatText] = useState("");
  const [visibleEffect, setVisibleEffect] = useState<GameEffect | null>(null);
  const [seconds, setSeconds] = useState(Date.now());
  const chatEnd = useRef<HTMLDivElement>(null);
  const seenChatRoom = useRef("");
  const seenChatCount = useRef(0);
  const shownEffectId = useRef<string | null>(null);
  const reconnectToken = useMemo(playerToken, []);
  const profileRef = useRef(profile);
  const inviteHandled = useRef(false);
  profileRef.current = profile;

  const notify = useCallback((text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice(""), 3000);
  }, []);

  useEffect(() => {
    const client = io({
      path: "/uno/socket.io",
      transports: ["polling"],
      reconnection: true,
      reconnectionAttempts: Infinity,
    });
    setSocket(client);
    client.on("rooms:list", (items: PublicRoom[]) => setPublicRooms(items));
    client.on("room:update", (next: RoomView) => setRoom(next));
    client.on("room:chat", (messages: ChatMessage[]) =>
      setRoom((previous) => previous ? { ...previous, chat: messages } : previous),
    );
    client.on("room:error", (message: string) => setError(message));
    client.on("connect", () => {
      setError("");
      const lastRoom = readStorage<{ code: string } | null>("uno-last-room", null);
      if (lastRoom && !new URLSearchParams(location.search).has("s")) {
        client.emit(
          "room:join",
          { code: lastRoom.code, profile: profileRef.current, token: reconnectToken },
          (response: AckResponse) => {
            if (response.ok && response.room) setRoom(response.room);
            else if (response.error) {
              localStorage.removeItem("uno-last-room");
              setError(response.error);
            }
          },
        );
      }
    });
    client.on("disconnect", () => notify("Conexão interrompida. Reconectando…"));
    return () => {
      client.disconnect();
    };
  }, [notify, reconnectToken]);

  useEffect(() => {
    if (room) localStorage.setItem("uno-last-room", JSON.stringify({ code: room.code }));
  }, [room]);

  useEffect(() => {
    if (!room?.game) return;
    const timer = window.setInterval(() => setSeconds(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [room?.game]);

  useEffect(() => {
    const effect = room?.game?.lastEffect;
    if (!effect || effect.id === shownEffectId.current) return;
    shownEffectId.current = effect.id;
    setVisibleEffect(effect);
    const timeout = window.setTimeout(() => {
      setVisibleEffect((current) => current?.id === effect.id ? null : current);
    }, 3200);
    return () => window.clearTimeout(timeout);
  }, [room?.game?.lastEffect?.id]);

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [room?.chat.length, chatOpen]);

  useEffect(() => {
    if (!room) {
      seenChatRoom.current = "";
      seenChatCount.current = 0;
      setUnreadChat(0);
      return;
    }
    if (seenChatRoom.current !== room.code) {
      seenChatRoom.current = room.code;
      seenChatCount.current = room.chat.length;
      setUnreadChat(0);
      return;
    }
    const newMessages = Math.max(0, room.chat.length - seenChatCount.current);
    seenChatCount.current = room.chat.length;
    if (chatOpen || window.matchMedia("(min-width: 681px)").matches) setUnreadChat(0);
    else if (newMessages) setUnreadChat((count) => Math.min(99, count + newMessages));
  }, [room?.code, room?.chat.length, chatOpen]);

  useEffect(() => {
    const invite = new URLSearchParams(location.search).get("s");
    if (invite && socket?.connected && !room && !inviteHandled.current) {
      inviteHandled.current = true;
      setJoinCode(invite.toUpperCase());
      setDialog("join");
    }
  }, [room, socket?.connected]);

  const emit = useCallback(
    (event: string, payload?: unknown, onSuccess?: (result: AckResponse) => void) => {
      if (!socket?.connected) {
        setError("Sem conexão com o servidor. Verifique se o jogo está aberto no computador anfitrião.");
        return;
      }
      const ack = (result: AckResponse) => {
        if (!result.ok) {
          setError(result.error ?? "Não foi possível concluir a ação.");
          return;
        }
        setError("");
        if (result.room) setRoom(result.room);
        onSuccess?.(result);
      };
      if (payload === undefined) socket.emit(event, ack);
      else socket.emit(event, payload, ack);
    },
    [socket],
  );

  const saveProfile = (next: PlayerProfile) => {
    setProfile(next);
    localStorage.setItem("uno-profile", JSON.stringify(next));
  };
  const saveSettings = (next: RoomSettings) => {
    setSettings(next);
    localStorage.setItem("uno-settings", JSON.stringify(next));
  };
  const checkProfile = () => {
    if (profile.name.trim()) return true;
    setError("Escolha um apelido antes de jogar.");
    setDialog("profile");
    return false;
  };

  const createRoom = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!checkProfile()) return;
    const input: RoomCreateInput = {
      name: roomName,
      profile,
      settings,
      token: reconnectToken,
      password: settings.public || settings.solo ? undefined : password,
    };
    emit("room:create", input, () => {
      setDialog(null);
      setPassword("");
    });
  };
  const joinRoom = (event?: FormEvent<HTMLFormElement>, code = joinCode) => {
    event?.preventDefault();
    if (!checkProfile()) return;
    const input: RoomJoinInput = { code, profile, password, token: reconnectToken };
    emit("room:join", input, () => {
      setDialog(null);
      setPassword("");
    });
  };
  const leaveRoom = () => {
    emit("room:leave");
    localStorage.removeItem("uno-last-room");
    setRoom(null);
  };
  const copyInvite = async () => {
    if (!room) return;
    let origin = location.origin;
    if (["localhost", "127.0.0.1"].includes(location.hostname)) {
      try {
        const response = await fetch("/api/network");
        const info = (await response.json()) as { address: string | null };
        if (!response.ok || !info.address) throw new Error("Endereço de rede indisponível.");
        const inviteOrigin = new URL(origin);
        inviteOrigin.hostname = info.address;
        origin = inviteOrigin.origin;
      } catch {
        setError("Não encontrei o endereço da rede. Compartilhe o IP local do computador e o código da sala.");
        return;
      }
    }
    const invite = `${origin}/uno/?s=${room.code}`;
    try {
      await navigator.clipboard.writeText(invite);
      notify("Convite copiado!");
    } catch {
      window.prompt("Copie o link de convite:", invite);
    }
  };
  const playCard = (card: Card) => {
    if (!room || !playable(card, room)) return notify("Essa carta não pode ser jogada agora.");
    if (card.color === "wild") setWildCard(card);
    else emit("game:play", { cardId: card.id });
  };
  const sendChat = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (chatText.trim()) emit("room:chat", chatText, () => setChatText(""));
  };

  if (room?.game && (room.status === "playing" || room.status === "finished")) {
    const me = room.players.find((player) => player.id === room.myPlayerId)!;
    const game = room.game;
    const myTurn = room.status === "playing" && game.currentPlayerId === me.id;
    const secondsLeft = Math.max(0, Math.ceil((game.turnEndsAt - seconds) / 1000));
    const winner = room.players.find((player) => player.id === game.winnerId);
    const currentPlayer = room.players.find((player) => player.id === game.currentPlayerId);
    return (
      <main className="game-shell">
        <header className="game-topbar">
          <Brand />
          <div className="game-room-tag"><span className="status-dot" />{room.name}<b>·</b><strong>{room.code}</strong></div>
          <div className="game-top-actions">
            <button className="icon-button chat-toggle" onClick={() => setChatOpen(!chatOpen)} aria-label={chatOpen ? "Fechar chat" : "Abrir chat"} aria-expanded={chatOpen}>
              <span className="icon-menu" aria-hidden="true" />{unreadChat > 0 && !chatOpen && <span className="chat-unread">{unreadChat > 9 ? "9+" : unreadChat}</span>}
            </button>
            <button className="back-button" onClick={leaveRoom}>SAIR ↗</button>
          </div>
        </header>
        <section className="game-layout">
          <div className="table-area">
            <div className="table-topline"><span>{room.settings.solo ? "PARTIDA SOLO" : "PARTIDA CASUAL"}</span><span>{room.players.length} JOGADORES</span></div>
            <div className="opponent-row">
              {room.players.filter((player) => player.id !== me.id).map((player) =>
                <PlayerPill key={player.id} player={player} mine={false} active={game.currentPlayerId === player.id} />,
              )}
            </div>
            {currentPlayer?.isBot && currentPlayer.isThinking && <div className="bot-thinking-banner" role="status" aria-live="polite">
              <span className="thinking-avatar"><AvatarMark avatar={currentPlayer.avatar} /></span>
              <span><strong>{currentPlayer.name}</strong><small>{game.recentAction}</small></span>
              <span className="thinking-dots" aria-label="Pensando"><i /><i /><i /></span>
            </div>}
            <div className="table-center">
              <div className="table-halo" />
              {visibleEffect && <GameEffectBanner effect={visibleEffect} myPlayerId={me.id} />}
              <button className="table-pile pile-draw" disabled={!myTurn || game.canPass} onClick={() => emit("game:draw")}>
                <div className="deck-back"><span>U</span></div><small>COMPRAR{game.drawCount ? ` ${game.drawCount}` : ""}</small>
              </button>
              <div className="turn-arrow">{game.direction === 1 ? "↻" : "↺"}</div>
              <div className="table-pile pile-discard"><PlayingCard card={game.topCard} large /><small>DESCARTE</small></div>
              <div className="active-color"><span className={`color-dot ${game.activeColor}`} />COR ATIVA · {COLOR_NAMES[game.activeColor].toUpperCase()}</div>
            </div>
            <div className={`turn-status ${currentPlayer?.isThinking ? "bot-turn-thinking" : ""}`}><span className={`status-dot ${myTurn || currentPlayer?.isThinking ? "" : "muted-dot"}`} /><strong>{myTurn ? "Sua vez!" : currentPlayer?.isThinking ? `${currentPlayer.name} está pensando…` : `${currentPlayer?.name ?? "Outro jogador"} está jogando`}</strong><span className="turn-timer">◷ {secondsLeft}s</span></div>
            <p className="action-message">{game.recentAction}</p>
            {game.unoPendingId && game.unoPendingId !== me.id &&
              <button className="catch-uno" onClick={() => emit("game:catch", game.unoPendingId)}>⚑ CONTESTAR UNO · +2</button>}
            <div className="hand-area">
              <div className="hand-heading"><span>SUA MÃO <b>{me.hand.length}</b></span>{myTurn && <span className="your-turn-label">É A SUA VEZ</span>}</div>
              <div className="hand-cards">
                {me.hand.map((card) =>
                  <button
                    key={card.id}
                    className="hand-card-wrap"
                    onClick={() => playCard(card)}
                    disabled={!myTurn}
                    aria-label={`Jogar ${label(card.value)}`}
                  ><PlayingCard card={card} /></button>,
                )}
              </div>
              <div className="hand-controls">
                <button className="button button-secondary" disabled={!myTurn || game.canPass} onClick={() => emit("game:draw")}>
                  ＋ {game.drawCount ? `COMPRAR ${game.drawCount} CARTAS` : "COMPRAR CARTA"}
                </button>
                {myTurn && game.canPass && <button className="button button-secondary" onClick={() => emit("game:pass")}>PASSAR A VEZ ↗</button>}
                {me.hand.length === 1 && game.unoPendingId === me.id && <button className="button button-uno" onClick={() => emit("game:uno")}>UNO!</button>}
                <span className="hand-hint">Combine cor ou número para jogar</span>
              </div>
            </div>
          </div>
          <aside className={`game-sidebar ${chatOpen ? "chat-open" : ""}`}>
            <div className="sidebar-tabs"><strong>CHAT DA MESA</strong><button className="icon-button sidebar-close" onClick={() => setChatOpen(false)} aria-label="Fechar chat">×</button></div>
            <div className="chat-log">
              {!room.chat.length && <div className="chat-empty"><span className="icon-spark" aria-hidden="true" /><strong>A conversa começa aqui</strong><small>Envie uma mensagem para a mesa.</small></div>}
              {room.chat.map((message) => <ChatLine key={message.id} message={message} />)}
              <div ref={chatEnd} />
            </div>
            <form className="chat-form" onSubmit={sendChat}>
              <input aria-label="Mensagem para a mesa" value={chatText} onChange={(event) => setChatText(event.target.value)} maxLength={240} placeholder="Escreva uma mensagem..." />
              <button type="submit" aria-label="Enviar mensagem" disabled={!chatText.trim()}>
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 9.2 17 3l-4.8 14-2.6-5.6L3 9.2Z" /><path d="m9.6 11.4 3.8-4" /></svg>
                <span>Enviar</span>
              </button>
            </form>
            <div className="sidebar-players"><span>NA MESA</span>{room.players.map((player) =>
              <PlayerPill key={player.id} player={player} active={game.currentPlayerId === player.id} mine={player.id === me.id} />,
            )}</div>
          </aside>
        </section>
        {room.status === "finished" && <VictoryCelebration
          winner={winner}
          isSolo={room.settings.solo}
          canReplay={room.hostId === me.id}
          onReplay={() => emit("room:replay")}
          onLeave={leaveRoom}
        />}
        {wildCard && <Dialog onClose={() => setWildCard(null)}><div className="dialog-content">
          <div className="dialog-kicker">CURINGA JOGADO</div><h2>Escolha a próxima cor</h2>
          <div className="color-picker">{COLORS.map((color) =>
            <button key={color} className={`color-choice ${color}`} onClick={() => { emit("game:play", { cardId: wildCard.id, chosenColor: color }); setWildCard(null); }}>
              <span className={`color-dot ${color}`} />{COLOR_NAMES[color]}
            </button>,
          )}</div>
        </div></Dialog>}
        {error && <Toast message={error} isError onClose={() => setError("")} />}
        {notice && <Toast message={notice} onClose={() => setNotice("")} />}
      </main>
    );
  }

  if (room) {
    const me = room.players.find((player) => player.id === room.myPlayerId);
    const readyToStart = room.players.length >= 2 && room.players.every((player) => player.ready && player.connected);
    return (
      <main className="lobby-shell">
        <header className="topbar"><Brand /><button className="back-button" onClick={leaveRoom}>← SAIR DA SALA</button></header>
        <section className="lobby-layout">
          <div className="lobby-main">
            <div className="eyebrow"><span /> SALA DE ESPERA</div>
            <div className="lobby-title-row"><div><h1>{room.name}</h1><p>{room.settings.solo ? "Prepare-se para a partida." : "Prepare-se para jogar com seus amigos."}</p></div><span className="room-visibility">{room.settings.solo ? "MODO SOLO" : room.isPrivate ? <><span className="icon-lock" aria-hidden="true" /> PRIVADA</> : "◉ PÚBLICA"}</span></div>
            <div className="invite-panel"><div><small>CÓDIGO DA SALA</small><strong>{room.code}</strong></div><button className="button button-secondary" onClick={copyInvite}>COPIAR CONVITE ↗</button></div>
            <div className="players-heading"><h2>Jogadores <span>{room.players.length}/{room.settings.maxPlayers}</span></h2><span>{room.settings.solo ? "ADVERSÁRIOS SERÃO ADICIONADOS" : "AGUARDANDO PARTICIPANTES"}</span></div>
            <div className="lobby-players">
              {room.players.map((player) => <PlayerPill key={player.id} player={player} mine={player.id === room.myPlayerId} active={false} />)}
              {Array.from({ length: Math.max(0, Math.min(4, room.settings.maxPlayers - room.players.length)) }, (_, index) =>
                <div className="empty-seat" key={index}><span>＋</span><small>{room.settings.solo ? "Lugar reservado" : "Aguardando jogador"}</small></div>,
              )}
            </div>
            <div className="lobby-bottom">
              <div className="ready-copy"><span className="status-dot" /><strong>{room.settings.solo ? "Sua partida solo está pronta" : readyToStart ? "Mesa pronta para começar" : "Esperando todo mundo ficar pronto"}</strong><small>{room.settings.solo ? `${room.settings.maxPlayers - 1} adversário(s) entrarão quando começar.` : "Convide amigos usando o código da sala."}</small></div>
              <div className="lobby-actions">
                {!room.settings.solo && !me?.isHost && <button className={`button ${me?.ready ? "button-ready" : "button-secondary"}`} onClick={() => emit("room:ready")}>{me?.ready ? "✓ PRONTO" : "FICAR PRONTO"}</button>}
                {me?.isHost && <button className="button button-primary button-large" disabled={room.settings.solo ? false : !readyToStart} onClick={() => emit("room:start")}>INICIAR PARTIDA ↗</button>}
              </div>
            </div>
          </div>
          <aside className="lobby-side">
            <div className="side-heading"><span className="section-kicker">REGRAS DA PARTIDA</span></div>
            <div className="lobby-rule"><span>Modo</span><strong>{room.settings.solo ? "Solo" : "Clássico"}</strong></div>
            <div className="lobby-rule"><span>Jogadores na mesa</span><strong>{room.settings.maxPlayers}</strong></div>
            <div className="lobby-rule"><span>Cartas iniciais</span><strong>{room.settings.startingCards} cartas</strong></div>
            <div className="lobby-rule"><span>Tempo por turno</span><strong>{room.settings.turnSeconds}s</strong></div>
            <div className="lobby-rule"><span>Acumular compra</span><strong>{room.settings.allowStacking ? "Ativado · variante" : "Desativado"}</strong></div>
            <div className="lobby-tip"><span className="icon-spark" aria-hidden="true" /><p>{room.settings.solo ? "A partida começa assim que você quiser." : "O anfitrião inicia depois que todos ficarem prontos."}</p></div>
            <div className="lobby-chat-title">ATIVIDADE DA SALA</div>
            <div className="lobby-chat">{room.chat.slice(-5).map((message) => <p key={message.id}><span>{timeText(message.time)}</span> {message.text}</p>)}</div>
          </aside>
        </section>
        {error && <Toast message={error} isError onClose={() => setError("")} />}
        {notice && <Toast message={notice} onClose={() => setNotice("")} />}
      </main>
    );
  }

  return (
    <main className="home-shell">
      <div className="ambient ambient-one" /><div className="ambient ambient-two" />
      <header className="topbar"><Brand /></header>
      <section className="hero">
        <div className="hero-copy"><div className="eyebrow"><span /> A MESA ESTÁ ABERTA</div>
          <h1>Uma carta pode<br />mudar <span>tudo.</span></h1>
          <p>Chame seus amigos ou enfrente a inteligência artificial. A próxima carta pode mudar tudo.</p>
          <div className="hero-actions">
            <button className="button button-primary button-large" onClick={() => { setSettings({ ...settings, solo: false, public: true }); setDialog("create"); }}>JOGAR COM AMIGOS ↗</button>
            <button className="button button-secondary button-large" onClick={() => { setSettings({ ...settings, solo: true, public: false }); setRoomName("Partida solo"); setDialog("create"); }}><span className="icon-solo" aria-hidden="true" /> JOGAR SOLO</button>
          </div>
          <div className="hero-actions" style={{ marginTop: 10 }}>
            <button className="button button-secondary" onClick={() => { setDialog("join"); setJoinCode(""); }}>ENTRAR COM CÓDIGO</button>
            <button className="button button-secondary" onClick={() => setDialog("profile")}>PERFIL</button>
          </div>
        </div>
        <div className="hero-cards" aria-hidden="true">
          <div className="show-card card-blue"><span>7</span><strong>7</strong><i>7</i></div>
          <div className="show-card card-yellow"><span>2</span><strong>2</strong><i>2</i></div>
          <div className="show-card card-green"><span>↻</span><strong>↻</strong><i>↻</i></div>
          <div className="show-card card-red"><span>+2</span><strong>+2</strong><i>+2</i></div>
          <div className="hero-glow" />
        </div>
      </section>
      <section className="below-fold">
        <div className="section-heading"><div><span className="section-kicker">ENCONTRE SUA MESA</span><h2>Salas abertas <span>agora</span></h2></div>
          <button className="text-button" onClick={() => { setJoinCode(""); setDialog("join"); }}>ENTRAR COM CÓDIGO ↗</button>
        </div>
        {publicRooms.length ? <div className="room-grid">{publicRooms.slice(0, 3).map((publicRoom) =>
          <button className="public-room-card" key={publicRoom.code} onClick={() => joinRoom(undefined, publicRoom.code)}>
            <span className="room-card-icon"><span className="icon-room" aria-hidden="true" /></span><span className="room-card-main"><strong>{publicRoom.name}</strong><small>{publicRoom.players}/{publicRoom.maxPlayers} jogadores · Sala pública</small></span><span className="room-card-join">ENTRAR <b>↗</b></span>
          </button>,
        )}</div> : <div className="empty-rooms"><span className="empty-icon"><span className="icon-room" aria-hidden="true" /></span><div><strong>Nenhuma mesa aberta por enquanto</strong><small>Crie uma sala pública e convide seus amigos.</small></div>
          <button className="button button-small button-secondary" onClick={() => { setSettings({ ...settings, solo: false, public: true }); setDialog("create"); }}>CRIAR SALA</button></div>}
      </section>
      {error && <Toast message={error} isError onClose={() => setError("")} />}
      {notice && <Toast message={notice} onClose={() => setNotice("")} />}
      {dialog && <Dialog onClose={() => setDialog(null)}>
        {dialog === "create" && <form className="dialog-content" onSubmit={createRoom}>
          <div className="dialog-kicker">{settings.solo ? "JOGAR CONTRA A IA" : "NOVA PARTIDA"}</div><h2>{settings.solo ? "Monte sua partida solo" : "Prepare a mesa"}</h2>
          {!settings.solo && <label>Nome da sala<input value={roomName} onChange={(event) => setRoomName(event.target.value)} placeholder="Ex.: Noite de jogos" maxLength={32} /></label>}
          <ProfileEditor profile={profile} onSave={saveProfile} />
          <SettingsEditor settings={settings} onChange={saveSettings} />
          {!settings.public && !settings.solo && <label>Senha da sala<input value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Senha para seus amigos" maxLength={64} required /></label>}
          <div className="dialog-actions"><button type="button" className="button button-secondary" onClick={() => setDialog(null)}>CANCELAR</button><button className="button button-primary">{settings.solo ? "CRIAR PARTIDA SOLO" : "CRIAR SALA"} ↗</button></div>
        </form>}
        {dialog === "join" && <form className="dialog-content" onSubmit={(event) => joinRoom(event)}>
          <div className="dialog-kicker">JOGAR COM AMIGOS</div><h2>Entrar em uma sala</h2><ProfileEditor profile={profile} onSave={saveProfile} />
          <label>Código ou convite<input value={joinCode} onChange={(event) => setJoinCode(event.target.value.toUpperCase())} placeholder="Ex.: A7K2LM" maxLength={40} required /></label>
          <label>Senha <span className="label-optional">se houver</span><input value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Senha da sala privada" maxLength={64} /></label>
          <div className="dialog-actions"><button type="button" className="button button-secondary" onClick={() => setDialog(null)}>CANCELAR</button><button className="button button-primary">ENTRAR NA SALA ↗</button></div>
        </form>}
        {dialog === "profile" && <div className="dialog-content"><div className="dialog-kicker">SEU PERFIL</div><h2>Como quer jogar?</h2><ProfileEditor profile={profile} onSave={saveProfile} /><div className="dialog-actions"><button className="button button-primary" onClick={() => setDialog(null)}>PRONTO</button></div></div>}
        {dialog === "rules" && <div className="dialog-content"><div className="dialog-kicker">REGRAS DA MESA</div><h2>Como jogar</h2>
          <p className="rules-copy">Combine a carta do topo pela cor ou pelo número. Curingas podem ser jogados a qualquer momento. Seja o primeiro a ficar sem cartas.</p>
          <div className="rule-list"><p><b>⊘ Pular</b><span>O próximo jogador perde a vez.</span></p><p><b>⇄ Inverter</b><span>Inverte a direção da rodada.</span></p><p><b>+2 / +4</b><span>O próximo jogador compra cartas e perde a vez.</span></p><p><b>UNO</b><span>Declare quando ficar com uma carta.</span></p></div>
          <p className="rules-note">Acumular cartas de compra é uma variante opcional.</p><div className="dialog-actions"><button className="button button-primary" onClick={() => setDialog(null)}>ENTENDI</button></div>
        </div>}
      </Dialog>}
    </main>
  );
}

function Brand() {
  return <a className="brand" href="/" aria-label="UNO Arena início"><span className="brand-mark">U</span><span>UNO<span className="brand-light"> ARENA</span></span></a>;
}

function AvatarMark({ avatar }: { avatar: string }) {
  const legacyAvatars: Record<string, string> = {
    orbit: "fox", spark: "panda", comet: "frog", prism: "tiger",
    nova: "octopus", flare: "unicorn", halo: "dragon", pulse: "bear",
    "🎴": "fox", "🦊": "fox", "🐼": "panda", "🐸": "frog",
    "🐯": "tiger", "🐙": "octopus", "🦄": "unicorn", "🐲": "dragon",
    "🐵": "bear", "🐻": "bear",
  };
  const selectedAvatar = AVATARS.includes(avatar) ? avatar : legacyAvatars[avatar] ?? "fox";
  const emoji: Record<string, string> = {
    fox: "🦊",
    panda: "🐼",
    frog: "🐸",
    tiger: "🐯",
    octopus: "🐙",
    unicorn: "🦄",
    dragon: "🐲",
    bear: "🐻",
  };

  return <span className="avatar-mark" data-avatar={selectedAvatar} aria-hidden="true">{emoji[selectedAvatar]}</span>;
}

function ProfileEditor({ profile, onSave }: { profile: PlayerProfile; onSave: (profile: PlayerProfile) => void }) {
  return <div className="profile-editor"><label>Seu apelido<input value={profile.name} onChange={(event) => onSave({ ...profile, name: event.target.value })} maxLength={20} placeholder="Como quer ser chamado?" /></label>
    <div className="avatar-picker"><span>Escolha seu avatar</span><div>{AVATARS.map((avatar) =>
      <button type="button" key={avatar} className={profile.avatar === avatar ? "selected" : ""} aria-label={`Avatar ${AVATAR_NAMES[AVATARS.indexOf(avatar)]}`} title={AVATAR_NAMES[AVATARS.indexOf(avatar)]} onClick={() => onSave({ ...profile, avatar })}><AvatarMark avatar={avatar} /></button>,
    )}</div></div>
  </div>;
}

function SettingsEditor({ settings, onChange }: { settings: RoomSettings; onChange: (settings: RoomSettings) => void }) {
  const update = (patch: Partial<RoomSettings>) => onChange({ ...settings, ...patch });
  return <div className="settings-grid">
    <label>Formato<select value={settings.solo ? "solo" : settings.public ? "public" : "private"} onChange={(event) => {
      const solo = event.target.value === "solo";
      update({ solo, public: solo ? false : event.target.value === "public" });
    }}><option value="public">Multiplayer · sala pública</option><option value="private">Multiplayer · sala privada</option><option value="solo">Solo contra IA</option></select></label>
    <label>{settings.solo ? "Jogadores na mesa" : "Limite de jogadores"}<select value={settings.maxPlayers} onChange={(event) => update({ maxPlayers: Number(event.target.value) })}>
      {[2, 3, 4, 5, 6, 8, 10].map((count) => <option key={count} value={count}>{count} jogadores{settings.solo ? ` · você + ${count - 1} IA${count > 2 ? "s" : ""}` : ""}</option>)}
    </select></label>
    <label>Cartas iniciais<select value={settings.startingCards} onChange={(event) => update({ startingCards: Number(event.target.value) })}>{[5, 6, 7, 8, 9, 10].map((count) => <option key={count} value={count}>{count} cartas</option>)}</select></label>
    <label>Tempo por turno<select value={settings.turnSeconds} onChange={(event) => update({ turnSeconds: Number(event.target.value) })}>{[15, 30, 45, 60, 90, 120].map((time) => <option key={time} value={time}>{time} segundos</option>)}</select></label>
    <label className="check-label"><input type="checkbox" checked={settings.allowStacking} onChange={(event) => update({ allowStacking: event.target.checked })} /><span>Permitir acumular cartas +2/+4</span></label>
  </div>;
}

function Dialog({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <section className="modal-card" role="dialog" aria-modal="true"><button className="modal-close" aria-label="Fechar" onClick={onClose}>×</button>{children}</section>
  </div>;
}

function PlayerPill({ player, active, mine }: { player: RoomView["players"][number]; active: boolean; mine: boolean }) {
  return <div className={`player-pill ${active ? "player-active" : ""} ${mine ? "player-mine" : ""} ${player.isThinking ? "player-thinking" : ""}`}>
    <span className="player-avatar"><AvatarMark avatar={player.avatar} /></span>
    <span className="player-ident">
      <b>{player.name}{mine ? " (você)" : ""}</b>
      {!player.isBot && <small>{player.connected ? "Conectado" : "Reconectando…"}</small>}
    </span>
    {player.cardCount > 0 && <span className="player-count">{player.cardCount}<small>cartas</small></span>}
    {player.isHost && <span className="host-crown" aria-label="Anfitrião"><span className="icon-crown" aria-hidden="true" /></span>}
  </div>;
}

function GameEffectBanner({ effect, myPlayerId }: { effect: GameEffect; myPlayerId: string }) {
  const isTarget = effect.targetId === myPlayerId;
  const target = isTarget ? "você" : effect.targetName ?? "o próximo jogador";
  let message: string;
  let symbol: string;

  if (effect.kind === "draw") {
    symbol = `+${effect.amount}`;
    const colorNotice = effect.color
      ? ` A cor ativa agora é ${COLOR_NAMES[effect.color].toLowerCase()}.`
      : "";
    message = effect.stacked
      ? isTarget
        ? `${effect.actorName} passou +${effect.amount} cartas para você acumular ou comprar.${colorNotice}`
        : `${effect.actorName} passou uma penalidade de ${effect.amount} cartas para ${target}.${colorNotice}`
      : isTarget
        ? `${effect.actorName} fez você comprar ${effect.amount} cartas.${colorNotice}`
        : `${effect.actorName} fez ${target} comprar ${effect.amount} cartas.${colorNotice}`;
  } else if (effect.kind === "skip") {
    symbol = "⊘";
    message = isTarget
      ? `${effect.actorName} pulou a sua vez.`
      : `${effect.actorName} pulou a vez de ${target}.`;
  } else if (effect.kind === "reverse") {
    symbol = "↻";
    message = `${effect.actorName} inverteu a direção da rodada.`;
  } else {
    symbol = "★";
    message = `${effect.actorName} escolheu a cor ${effect.color ? COLOR_NAMES[effect.color].toLowerCase() : "seguinte"}.`;
  }

  return <div className={`game-effect-banner effect-${effect.kind}`} role="status" aria-live="polite">
    <span className="game-effect-symbol">{symbol}</span>
    <span className="game-effect-copy"><small>EFEITO DA JOGADA</small><strong>{effect.kind === "draw" ? "Carta de compra" : effect.kind === "skip" ? "Vez pulada" : effect.kind === "reverse" ? "Sentido invertido" : "Curinga"}</strong><span>{message}</span></span>
  </div>;
}

function VictoryCelebration({
  winner,
  isSolo,
  canReplay,
  onReplay,
  onLeave,
}: {
  winner: RoomView["players"][number] | undefined;
  isSolo: boolean;
  canReplay: boolean;
  onReplay: () => void;
  onLeave: () => void;
}) {
  const confettiColors = ["#f04b52", "#f5c536", "#28a66a", "#287bd8", "#c4f169", "#fff1bd"];
  return <div className="winner-overlay">
    <div className="victory-confetti" aria-hidden="true">
      {Array.from({ length: 36 }, (_, index) => <i
        key={index}
        style={{
          left: `${(index * 37 + 9) % 100}%`,
          animationDelay: `${(index % 12) * -0.37}s`,
          animationDuration: `${4 + (index % 5) * 0.45}s`,
          backgroundColor: confettiColors[index % confettiColors.length],
        }}
      />)}
    </div>
    <section className="winner-card" role="dialog" aria-modal="true" aria-labelledby="winner-title">
      <span className="winner-sparkle" aria-hidden="true" />
      <div className="dialog-kicker">FIM DE JOGO · QUE PARTIDA!</div>
      <span className="victory-avatar" aria-hidden="true">{winner ? <AvatarMark avatar={winner.avatar} /> : <span className="icon-trophy" />}</span>
      <h1 id="winner-title">{winner?.name ?? "Um jogador"} venceu!</h1>
      <p>{winner?.isBot ? `${winner.name} levou essa rodada. Quer tentar de novo?` : isSolo ? "Você mandou muito bem! A mesa é sua." : "A mesa tem um novo campeão. Bora mais uma?"}</p>
      <div className="victory-ribbon"><span className="icon-trophy" aria-hidden="true" /><span>CAMPEÃO DA MESA</span><span className="icon-trophy" aria-hidden="true" /></div>
      <div className="dialog-actions">
        {canReplay && <button className="button button-primary" onClick={onReplay}>JOGAR DE NOVO ↗</button>}
        <button className="button button-secondary" onClick={onLeave}>VOLTAR AO INÍCIO</button>
      </div>
    </section>
  </div>;
}

function PlayingCard({ card, large = false }: { card: Pick<Card, "color" | "value">; large?: boolean }) {
  const symbol = label(card.value);
  return <span className={`playing-card color-${card.color} ${large ? "card-large" : ""}`}>
    <span className="card-corner">{symbol}</span>
    <span className={`card-oval ${card.color === "wild" ? "wild-oval" : ""}`}>
      <span className="card-mark">{symbol}</span>
    </span>
    <span className="card-corner card-corner-bottom">{symbol}</span>
  </span>;
}

function ChatLine({ message }: { message: ChatMessage }) {
  return <div className={`chat-message ${message.system ? "system-message" : ""}`}>
    <span className="chat-avatar">{message.system ? <span className="chat-system-mark">U</span> : <AvatarMark avatar={message.avatar} />}</span>
    <div><div className="chat-name">{message.sender}<time>{timeText(message.time)}</time></div><p>{message.text}</p></div>
  </div>;
}

function Toast({ message, isError = false, onClose }: { message: string; isError?: boolean; onClose: () => void }) {
  return <div className={`toast ${isError ? "toast-error" : ""}`} role={isError ? "alert" : "status"} aria-live={isError ? "assertive" : "polite"}>
    <span className="toast-icon" aria-hidden="true">{isError ? "!" : <span className="icon-spark" />}</span>
    <div className="toast-copy"><strong>{isError ? "Não foi possível continuar" : "Tudo certo"}</strong><p>{message}</p></div>
    <button onClick={onClose} aria-label="Fechar aviso">×</button>
  </div>;
}

export default App;
