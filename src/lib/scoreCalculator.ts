/**
 * Calcula los puntos ganados para una predicción del mundial (Reglas Antiguas)
 * - 1 punto si acierta el marcador exacto
 * - 0 puntos de lo contrario
 */
export function calculatePointsOld(
  predGoals1: number,
  predGoals2: number,
  realGoals1: number,
  realGoals2: number
): number {
  if (predGoals1 === realGoals1 && predGoals2 === realGoals2) {
    return 1;
  }
  return 0;
}

/**
 * Calcula los puntos ganados para una predicción del mundial (Reglas Nuevas - Desde 13 Junio 2026)
 * - 5 puntos si acierta el marcador exacto
 * - 3 puntos si acierta ganador y la misma diferencia de goles (solo si hay ganador, no empates)
 * - 1 punto si acierta resultado simple (ganador con otra diferencia, o empate no exacto)
 * - 0 puntos si no acierta
 */
export function calculatePointsNew(
  predGoals1: number,
  predGoals2: number,
  realGoals1: number,
  realGoals2: number
): number {
  // 1. Marcador Exacto (+5)
  if (predGoals1 === realGoals1 && predGoals2 === realGoals2) {
    return 5;
  }

  const predDiff = predGoals1 - predGoals2;
  const realDiff = realGoals1 - realGoals2;

  // 2. Ganador y diferencia (+3) - Solo aplica si hay un ganador, no para empates
  if (predDiff !== 0 && realDiff !== 0 && Math.sign(predDiff) === Math.sign(realDiff) && predDiff === realDiff) {
    return 3;
  }

  // 3. Resultado Simple (+1) - Acierta quién gana pero con otra diferencia, o acierta empate no exacto
  if (Math.sign(predDiff) === Math.sign(realDiff)) {
    return 1;
  }

  return 0;
}

// Para compatibilidad
export const calculatePoints = calculatePointsNew;
