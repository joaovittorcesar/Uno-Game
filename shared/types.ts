export type CardColor = "red" | "yellow" | "green" | "blue";
export type CardValue = number | "skip" | "reverse" | "draw2" | "wild" | "draw4";
export type RoomStatus = "lobby" | "playing" | "finished";

export interface Card {
  id: string;
  color: CardColor | "wild";
  value: CardValue;
}

export interface RoomSettings {
  maxPlayers: number;
  startingCards: number;
  turnSeconds: number;
  public: boolean;
  allowStacking: boolean;
  solo: boolean;
}

export interface PlayerView {
  id: string;
  name: string;
  avatar: string;
  ready: boolean;
  connected: boolean;
  cardCount: number;
  hand: Card[];
  isHost: boolean;
  isBot: boolean;
  isThinking: boolean;
  botStyle: "strategist" | "playful" | "bold" | "calm" | null;
}

export interface PublicCard {
  color: CardColor | "wild";
  value: CardValue;
}

export interface ChatMessage {
  id: string;
  sender: string;
  avatar: string;
  text: string;
  time: number;
  system?: boolean;
}

export interface GameEffect {
  id: string;
  kind: "draw" | "skip" | "reverse" | "wild";
  actorId: string;
  actorName: string;
  targetId: string | null;
  targetName: string | null;
  amount: number;
  color: CardColor | null;
  stacked: boolean;
}

export interface GameView {
  topCard: PublicCard;
  activeColor: CardColor;
  currentPlayerId: string;
  direction: 1 | -1;
  turnEndsAt: number;
  winnerId: string | null;
  drawCount: number;
  canPass: boolean;
  drawnCardId: string | null;
  unoPendingId: string | null;
  recentAction: string;
  lastEffect: GameEffect | null;
}

export interface RoomView {
  code: string;
  name: string;
  isPrivate: boolean;
  hostId: string;
  status: RoomStatus;
  settings: RoomSettings;
  players: PlayerView[];
  game: GameView | null;
  chat: ChatMessage[];
  myPlayerId: string;
}

export interface PublicRoom {
  code: string;
  name: string;
  players: number;
  maxPlayers: number;
  status: RoomStatus;
}

export interface PlayerProfile {
  name: string;
  avatar: string;
}

export interface RoomCreateInput {
  name: string;
  profile: PlayerProfile;
  settings: RoomSettings;
  password?: string;
  token: string;
}

export interface RoomJoinInput {
  code: string;
  profile: PlayerProfile;
  password?: string;
  token: string;
}

export interface GamePlayInput {
  cardId: string;
  chosenColor?: CardColor;
}

export interface GameCatchInput {
  playerId: string;
}

export interface AckResponse {
  ok: boolean;
  error?: string;
  room?: RoomView;
}
