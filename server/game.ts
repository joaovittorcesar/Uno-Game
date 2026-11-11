import { randomUUID } from "node:crypto";
import type { Card, CardColor, CardValue, GameEffect } from "../shared/types.ts";

export interface GamePlayer {
  id: string;
  name?: string;
  hand: Card[];
}

export interface GameState {
  deck: Card[];
  discard: Card[];
  activeColor: CardColor;
  currentIndex: number;
  direction: 1 | -1;
  turnEndsAt: number;
  winnerId: string | null;
  drawCount: number;
  hasDrawn: boolean;
  drawnCardId: string | null;
  unoPendingId: string | null;
  recentAction: string;
  lastEffect: GameEffect | null;
}

const COLORS: CardColor[] = ["red", "yellow", "green", "blue"];

function shuffle<T>(items: T[]): T[] {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [items[index], items[swapIndex]] = [items[swapIndex], items[index]];
  }
  return items;
}

export function createDeck(): Card[] {
  const cards: Card[] = [];
  for (const color of COLORS) {
    cards.push({ id: randomUUID(), color, value: 0 });
    for (let number = 1; number <= 9; number += 1) {
      cards.push({ id: randomUUID(), color, value: number });
      cards.push({ id: randomUUID(), color, value: number });
    }
    for (const value of ["skip", "reverse", "draw2"] as const) {
      cards.push({ id: randomUUID(), color, value });
      cards.push({ id: randomUUID(), color, value });
    }
  }
  for (let index = 0; index < 4; index += 1) {
    cards.push({ id: randomUUID(), color: "wild", value: "wild" });
    cards.push({ id: randomUUID(), color: "wild", value: "draw4" });
  }
  return shuffle(cards);
}

function recycleDeck(game: GameState): void {
  if (game.deck.length > 0 || game.discard.length <= 1) return;
  const top = game.discard.pop();
  game.deck = shuffle(game.discard);
  game.discard = top ? [top] : [];
}

export function drawCards(game: GameState, count: number): Card[] {
  const drawn: Card[] = [];
  for (let index = 0; index < count; index += 1) {
    recycleDeck(game);
    const card = game.deck.pop();
    if (!card) break;
    drawn.push(card);
  }
  return drawn;
}

function dealFromDeck(deck: Card[], count: number): Card[] {
  const cards: Card[] = [];
  for (let index = 0; index < count; index += 1) {
    const card = deck.pop();
    if (card) cards.push(card);
  }
  return cards;
}

export function startGame(
  players: GamePlayer[],
  startingCards: number,
  turnSeconds: number,
): GameState {
  if (players.length < 2) throw new Error("A partida precisa de pelo menos 2 jogadores.");
  const deck = createDeck();
  for (const player of players) {
    player.hand = dealFromDeck(deck, startingCards);
  }
  let first = deck.pop();
  while (first?.color === "wild" && deck.length) {
    deck.unshift(first);
    first = deck.pop();
  }
  if (!first) throw new Error("Não foi possível preparar o baralho.");
  const game: GameState = {
    deck,
    discard: [first],
    activeColor: first.color === "wild" ? COLORS[Math.floor(Math.random() * COLORS.length)] : first.color,
    currentIndex: 0,
    direction: 1,
    turnEndsAt: Date.now() + turnSeconds * 1000,
    winnerId: null,
    drawCount: 0,
    hasDrawn: false,
    drawnCardId: null,
    unoPendingId: null,
    recentAction: "A partida começou.",
    lastEffect: null,
  };
  if (first.value === "skip") {
    game.currentIndex = 2 % players.length;
  } else if (first.value === "reverse") {
    game.direction = -1;
    game.currentIndex = players.length === 2 ? 0 : players.length - 1;
  } else if (first.value === "draw2") {
    players[1].hand.push(...drawCards(game, 2));
    game.currentIndex = 2 % players.length;
  }
  return game;
}

export function currentPlayerId(players: GamePlayer[], game: GameState): string {
  const player = players[game.currentIndex];
  if (!player) throw new Error("A partida não tem jogadores.");
  return player.id;
}

export function isPlayable(card: Card, game: GameState): boolean {
  const top = game.discard.at(-1);
  if (!top) return true;
  return card.color === "wild" || card.color === game.activeColor || card.value === top.value;
}

export function chooseBotCard(
  hand: Card[],
  game: GameState,
  allowStacking: boolean,
): Card | undefined {
  const playable = hand.filter((card) => {
    if (game.drawnCardId && card.id !== game.drawnCardId) return false;
    if (card.value === "draw4" && hand.some((held) => held.id !== card.id && held.color === game.activeColor)) {
      return false;
    }
    if (game.drawCount > 0) {
      return allowStacking && (card.value === "draw2" || card.value === "draw4");
    }
    return isPlayable(card, game);
  });

  if (!playable.length) return undefined;
  return playable[Math.floor(Math.random() * playable.length)];
}

export function chooseBotColor(hand: Card[]): CardColor {
  const counts = COLORS.map((color) => ({
    color,
    count: hand.filter((card) => card.color === color).length,
  }));
  return counts.sort((left, right) => right.count - left.count)[0].color;
}

function canPlayFromHand(card: Card, player: GamePlayer, game: GameState): boolean {
  return (
    isPlayable(card, game) &&
    !(
      card.value === "draw4" &&
      player.hand.some((heldCard) => heldCard.id !== card.id && heldCard.color === game.activeColor)
    )
  );
}

function advance(game: GameState, playerCount: number, steps = 1): void {
  game.currentIndex =
    (game.currentIndex + game.direction * steps + playerCount * steps) % playerCount;
  game.hasDrawn = false;
  game.drawnCardId = null;
  game.turnEndsAt = Date.now() + 30_000;
}

export function playCard(
  players: GamePlayer[],
  game: GameState,
  playerId: string,
  cardId: string,
  chosenColor?: CardColor,
  turnSeconds = 30,
  allowStacking = false,
): Card {
  if (game.winnerId) throw new Error("A partida já terminou.");
  if (currentPlayerId(players, game) !== playerId) throw new Error("Ainda não é a sua vez.");
  const player = players[game.currentIndex];
  const cardIndex = player.hand.findIndex((card) => card.id === cardId);
  if (cardIndex < 0) throw new Error("Essa carta não está na sua mão.");
  if (game.hasDrawn && cardId !== game.drawnCardId) {
    throw new Error("Depois de comprar, você só pode jogar a carta que acabou de comprar.");
  }
  const card = player.hand[cardIndex];
  if (
    card.value === "draw4" &&
    player.hand.some((heldCard) => heldCard.id !== card.id && heldCard.color === game.activeColor)
  ) {
    throw new Error("O curinga +4 só pode ser usado quando você não tem a cor ativa.");
  }
  if (game.drawCount > 0 && !["draw2", "draw4"].includes(String(card.value))) {
    throw new Error("Você precisa acumular uma carta de compra ou comprar as cartas da penalidade.");
  }
  if (!isPlayable(card, game)) throw new Error("Essa carta não pode ser jogada agora.");
  if (card.color === "wild" && (!chosenColor || !COLORS.includes(chosenColor))) {
    throw new Error("Escolha uma cor válida para o curinga.");
  }
  if (chosenColor && card.color !== "wild") throw new Error("Esta carta não permite escolher uma cor.");

  player.hand.splice(cardIndex, 1);
  game.discard.push(card);
  game.activeColor = card.color === "wild" ? chosenColor! : card.color;
  game.unoPendingId = null;
  game.lastEffect = null;
  game.recentAction = `${card.value === "draw4" ? "+4" : card.value === "draw2" ? "+2" : String(card.value)} jogado.`;

  if (player.hand.length === 0) {
    game.winnerId = player.id;
    game.recentAction = "A partida terminou.";
    return card;
  }
  if (player.hand.length === 1) game.unoPendingId = player.id;

  const next = (game.currentIndex + game.direction + players.length) % players.length;
  if (card.value === "reverse") {
    game.lastEffect = {
      id: randomUUID(),
      kind: "reverse",
      actorId: player.id,
      actorName: player.name ?? player.id,
      targetId: null,
      targetName: null,
      amount: 0,
      color: null,
      stacked: false,
    };
    game.direction = game.direction === 1 ? -1 : 1;
    if (players.length > 2) advance(game, players.length);
  } else if (card.value === "skip") {
    const target = players[next];
    game.lastEffect = {
      id: randomUUID(),
      kind: "skip",
      actorId: player.id,
      actorName: player.name ?? player.id,
      targetId: target.id,
      targetName: target.name ?? target.id,
      amount: 0,
      color: null,
      stacked: false,
    };
    advance(game, players.length, 2);
  } else if (card.value === "draw2" || card.value === "draw4") {
    const target = players[next];
    const penalty = card.value === "draw2" ? 2 : 4;
    game.lastEffect = {
      id: randomUUID(),
      kind: "draw",
      actorId: player.id,
      actorName: player.name ?? player.id,
      targetId: target.id,
      targetName: target.name ?? target.id,
      amount: allowStacking ? game.drawCount + penalty : penalty,
      color: card.color === "wild" ? chosenColor! : null,
      stacked: allowStacking,
    };
    if (allowStacking) {
      game.drawCount += penalty;
      advance(game, players.length);
      game.recentAction = `Acumule ou compre ${game.drawCount} cartas.`;
    } else {
      target.hand.push(...drawCards(game, penalty));
      game.drawCount = 0;
      game.recentAction = `O próximo jogador comprou ${penalty} cartas.`;
      advance(game, players.length, 2);
    }
  } else {
    if (card.color === "wild") {
      game.lastEffect = {
        id: randomUUID(),
        kind: "wild",
        actorId: player.id,
        actorName: player.name ?? player.id,
        targetId: null,
        targetName: null,
        amount: 0,
        color: chosenColor!,
        stacked: false,
      };
    }
    game.drawCount = 0;
    advance(game, players.length);
  }
  game.turnEndsAt = Date.now() + turnSeconds * 1000;
  return card;
}

export function drawForTurn(
  players: GamePlayer[],
  game: GameState,
  playerId: string,
  turnSeconds: number,
): Card[] {
  if (game.winnerId) throw new Error("A partida já terminou.");
  if (currentPlayerId(players, game) !== playerId) throw new Error("Ainda não é a sua vez.");
  if (game.hasDrawn) throw new Error("Você já comprou nesta vez.");
  const player = players[game.currentIndex];
  if (game.unoPendingId && game.unoPendingId !== player.id) game.unoPendingId = null;
  if (game.drawCount > 0) {
    const penalty = game.drawCount;
    const cards = drawCards(game, penalty);
    player.hand.push(...cards);
    game.drawCount = 0;
    advance(game, players.length);
    game.turnEndsAt = Date.now() + turnSeconds * 1000;
    game.recentAction = `O jogador comprou ${cards.length} cartas da penalidade.`;
    return cards;
  }
  const cards = drawCards(game, 1);
  player.hand.push(...cards);
  game.hasDrawn = true;
  game.drawnCardId = cards[0]?.id ?? null;
  game.turnEndsAt = Date.now() + turnSeconds * 1000;
  game.recentAction = cards.length ? "Uma carta foi comprada." : "O monte de compra está vazio.";
  if (cards.length === 0 || !player.hand.some((card) => canPlayFromHand(card, player, game))) {
    advance(game, players.length);
    game.turnEndsAt = Date.now() + turnSeconds * 1000;
  }
  return cards;
}

export function passTurn(
  players: GamePlayer[],
  game: GameState,
  playerId: string,
  turnSeconds: number,
): void {
  if (currentPlayerId(players, game) !== playerId) throw new Error("Ainda não é a sua vez.");
  if (!game.hasDrawn) throw new Error("Compre uma carta antes de passar.");
  if (game.unoPendingId && game.unoPendingId !== playerId) game.unoPendingId = null;
  advance(game, players.length);
  game.turnEndsAt = Date.now() + turnSeconds * 1000;
  game.recentAction = "A vez foi passada.";
}

export function cardName(value: CardValue): string {
  return value === "draw2" ? "+2" : value === "draw4" ? "+4" : value === "reverse" ? "⇄" : value === "skip" ? "⊘" : value === "wild" ? "★" : String(value);
}
