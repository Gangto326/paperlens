/** 정렬된 문장 ID 목록에서 선택 범위 바깥의 이전/다음 문장을 찾는다. 끝에서는 순환하지 않는다. */
export function adjacentSentenceId(
  orderedIds: readonly string[],
  selectedIds: readonly string[],
  direction: -1 | 1,
): string | null {
  const selected = new Set(selectedIds);
  const positions = orderedIds.flatMap((id, i) => (selected.has(id) ? [i] : []));
  if (positions.length === 0) return direction === 1 ? (orderedIds[0] ?? null) : null;
  const edge = direction === 1 ? Math.max(...positions) : Math.min(...positions);
  return orderedIds[edge + direction] ?? null;
}
