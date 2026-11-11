import { describe, expect, it, vi } from "vitest";
import type { Card, CardColor } from "../shared/types.ts";
import { assertPlayerNameAvailable, normalizePlayerName } from "../server/player-name.ts";
import {
  createDeck,
  chooseBotCard,
  chooseBotColor,
  drawForTurn,
  isPlayable,
  playCard,
  passTurn,
  startGame,
  type GamePlayer,
  type GameState,
} from "../server/game.ts";

function card(id: string, color: CardColor | "wild", value: Card["value"]): Card {
  return { id, color, value };
}

function gameFor(players: GamePlayer[], top = card("top", "red", 5)): GameState {
  return {
    deck: createDeck(),
    discard: [top],
    activeColor: top.color === "wild" ? "red" : top.color,
    currentIndex: 0,
    direction: 1,
    turnEndsAt: Date.now() + 30_000,
    winnerId: null,
    drawCount: 0,
    hasDrawn: false,
    drawnCardId: null,
    unoPendingId: null,
    recentAction: "",
    lastEffect: null,
  };
}

describe("UNO ARENA game rules", () => {
  it("rejects duplicate player names regardless of case, spacing, or accents", () => {
    const players = [{ id: "p1", name: "João  Silva" }];

    expect(normalizePlayerName("  JOAO Silva ")).toBe("joao silva");
    expect(() => assertPlayerNameAvailable("Joao Silva", players)).toThrow(/já existe um jogador/i);
    expect(() => assertPlayerNameAvailable("João Silva", players, "p1")).not.toThrow();
  });

  it("creates a standard 108-card deck with unique card IDs", () => {
    const deck = createDeck();
    expect(deck).toHaveLength(108);
    expect(new Set(deck.map((entry) => entry.id)).size).toBe(108);
    expect(deck.filter((entry) => entry.color === "wild")).toHaveLength(8);
  });

  it("deals the configured hand and preserves every card in the deck", () => {
    const players: GamePlayer[] = [{ id: "p1", hand: [] }, { id: "p2", hand: [] }];
    const game = startGame(players, 7, 45);
    expect(players.map((player) => player.hand)).toHaveLength(2);
    expect(players[0].hand).toHaveLength(7);
    expect(game.discard).toHaveLength(1);
    expect(players[1].hand.length).toBeGreaterThanOrEqual(7);
    const cardsInPlay = players.reduce((total, player) => total + player.hand.length, 0);
    expect(game.deck.length + cardsInPlay + game.discard.length).toBe(108);
  });

  it("allows matching by active color, value, or wild card", () => {
    const game = gameFor([]);
    expect(isPlayable(card("same-color", "red", 2), game)).toBe(true);
    expect(isPlayable(card("same-value", "blue", 5), game)).toBe(true);
    expect(isPlayable(card("wild", "wild", "wild"), game)).toBe(true);
    expect(isPlayable(card("invalid", "blue", 2), game)).toBe(false);
  });

  it("varies the bot's legal moves and picks its most common color", () => {
    const game = gameFor([]);
    const hand = [
      card("matching", "red", 2),
      card("wild", "wild", "wild"),
      card("blue-one", "blue", 1),
      card("blue-two", "blue", 4),
    ];
    const random = vi.spyOn(Math, "random");
    random.mockReturnValueOnce(0);
    expect(chooseBotCard(hand, game, false)?.id).toBe("matching");
    random.mockReturnValueOnce(0.99);
    expect(chooseBotCard(hand, game, false)?.id).toBe("wild");
    random.mockRestore();
    expect(chooseBotColor(hand)).toBe("blue");
  });

  it("rejects out-of-turn and invalid cards without changing a hand", () => {
    const players: GamePlayer[] = [
      { id: "p1", hand: [card("wrong", "blue", 2)] },
      { id: "p2", hand: [card("valid", "red", 1)] },
    ];
    const game = gameFor(players);
    expect(() => playCard(players, game, "p2", "valid")).toThrow("Ainda não é a sua vez.");
    expect(() => playCard(players, game, "p1", "wrong")).toThrow("Essa carta não pode ser jogada agora.");
    expect(players[0].hand).toHaveLength(1);
  });

  it("requires a valid color for a wild card and records UNO at one card", () => {
    const players: GamePlayer[] = [
      { id: "p1", hand: [card("wild", "wild", "wild"), card("last", "blue", 1)] },
      { id: "p2", hand: [card("p2-card", "green", 4)] },
    ];
    const game = gameFor(players);
    expect(() => playCard(players, game, "p1", "wild")).toThrow("Escolha uma cor válida");
    playCard(players, game, "p1", "wild", "blue");
    expect(game.activeColor).toBe("blue");
    expect(game.unoPendingId).toBe("p1");
    expect(game.currentIndex).toBe(1);
    expect(game.lastEffect).toMatchObject({ kind: "wild", actorName: "p1", color: "blue" });
  });

  it("rejects +4 when the player still holds the active color", () => {
    const players: GamePlayer[] = [
      { id: "p1", hand: [card("draw4", "wild", "draw4"), card("same-color", "red", 1)] },
      { id: "p2", hand: [card("p2-card", "green", 4)] },
    ];
    const game = gameFor(players);
    expect(() => playCard(players, game, "p1", "draw4", "blue")).toThrow("não tem a cor ativa");
    expect(players[0].hand).toHaveLength(2);
  });

  it("applies skip and reverse effects, including reverse in a two-player game", () => {
    const threePlayers: GamePlayer[] = [
      { id: "p1", hand: [card("skip", "red", "skip"), card("extra", "blue", 2)] },
      { id: "p2", hand: [card("p2", "yellow", 1)] },
      { id: "p3", hand: [card("p3", "green", 1)] },
    ];
    const skipGame = gameFor(threePlayers);
    playCard(threePlayers, skipGame, "p1", "skip");
    expect(skipGame.currentIndex).toBe(2);
    expect(skipGame.lastEffect).toMatchObject({ kind: "skip", actorName: "p1", targetName: "p2" });

    const twoPlayers: GamePlayer[] = [
      { id: "p1", hand: [card("reverse", "red", "reverse"), card("extra", "blue", 2)] },
      { id: "p2", hand: [card("p2", "yellow", 1)] },
    ];
    const reverseGame = gameFor(twoPlayers);
    playCard(twoPlayers, reverseGame, "p1", "reverse");
    expect(reverseGame.direction).toBe(-1);
    expect(reverseGame.currentIndex).toBe(0);
    expect(reverseGame.lastEffect).toMatchObject({ kind: "reverse", actorName: "p1" });
  });

  it("applies +2 penalties and skips the next player in classic mode", () => {
    const players: GamePlayer[] = [
      { id: "p1", hand: [card("draw2", "red", "draw2"), card("extra", "blue", 2)] },
      { id: "p2", hand: [card("p2", "yellow", 1)] },
      { id: "p3", hand: [card("p3", "green", 1)] },
    ];
    const game = gameFor(players);
    playCard(players, game, "p1", "draw2");
    expect(players[1].hand).toHaveLength(3);
    expect(game.currentIndex).toBe(2);
    expect(game.drawCount).toBe(0);
    expect(game.lastEffect).toMatchObject({
      kind: "draw",
      actorId: "p1",
      targetId: "p2",
      amount: 2,
      stacked: false,
    });
  });

  it("accumulates draw cards only when the room enables the variant", () => {
    const players: GamePlayer[] = [
      { id: "p1", hand: [card("draw2", "red", "draw2"), card("p1-extra", "blue", 2)] },
      { id: "p2", hand: [card("draw2-next", "blue", "draw2"), card("p2-extra", "green", 1)] },
      { id: "p3", hand: [card("p3", "yellow", 1)] },
    ];
    const game = gameFor(players);
    playCard(players, game, "p1", "draw2", undefined, 30, true);
    expect(game.currentIndex).toBe(1);
    expect(game.drawCount).toBe(2);
    expect(game.lastEffect).toMatchObject({ kind: "draw", targetName: "p2", amount: 2, stacked: true });
    playCard(players, game, "p2", "draw2-next", undefined, 30, true);
    expect(game.currentIndex).toBe(2);
    expect(game.drawCount).toBe(4);
    expect(game.lastEffect).toMatchObject({ kind: "draw", targetName: "p3", amount: 4, stacked: true });
    const previousHandSize = players[2].hand.length;
    drawForTurn(players, game, "p3", 30);
    expect(players[2].hand).toHaveLength(previousHandSize + 4);
    expect(game.currentIndex).toBe(0);
    expect(game.drawCount).toBe(0);
  });

  it("allows passing only after drawing a regular card", () => {
    const players: GamePlayer[] = [
      { id: "p1", hand: [card("p1", "blue", 1)] },
      { id: "p2", hand: [card("p2", "green", 2)] },
    ];
    const game = gameFor(players);
    game.deck = [card("drawn", "red", 2)];
    expect(() => passTurn(players, game, "p1", 30)).toThrow("Compre uma carta antes de passar.");
    drawForTurn(players, game, "p1", 30);
    expect(game.drawnCardId).toBe("drawn");
    passTurn(players, game, "p1", 30);
    expect(game.currentIndex).toBe(1);
  });

  it("allows only the newly drawn card to be played after buying", () => {
    const players: GamePlayer[] = [
      { id: "p1", hand: [card("old", "red", 1), card("other", "blue", 3)] },
      { id: "p2", hand: [card("p2", "green", 2)] },
    ];
    const game = gameFor(players);
    game.deck = [card("drawn", "red", 3)];
    drawForTurn(players, game, "p1", 30);
    expect(() => playCard(players, game, "p1", "old")).toThrow("só pode jogar a carta que acabou de comprar");
    playCard(players, game, "p1", "drawn");
    expect(game.currentIndex).toBe(1);
  });
});
