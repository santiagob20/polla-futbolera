/**
 * Calcula los puntos ganados para una predicción del mundial
 * - 3 puntos si acierta el marcador exacto
 * - 1 punto si acierta el ganador o el empate (sin marcador exacto)
 * - 0 puntos si no acierta el resultado
 */
export function calculatePoints(
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
