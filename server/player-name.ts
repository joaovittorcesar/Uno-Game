export function normalizePlayerName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("pt-BR");
}

export function assertPlayerNameAvailable(
  name: string,
  players: readonly { id: string; name: string }[],
  currentPlayerId?: string,
): void {
  const normalizedName = normalizePlayerName(name);
  const nameTaken = players.some((player) =>
    player.id !== currentPlayerId && normalizePlayerName(player.name) === normalizedName,
  );
  if (nameTaken) {
    throw new Error("Já existe um jogador com esse nome nesta sala. Escolha outro apelido para evitar confusão.");
  }
}
