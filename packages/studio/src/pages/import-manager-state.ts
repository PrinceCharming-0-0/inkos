// Pure helpers extracted from ImportManager.tsx so the canon import guard
// (source-equals-target + empty book list) can be unit-tested without React
// rendering. The component reads the same values back through these helpers
// to keep the disabled/enabled state and the handler's early-return in sync.

export type CanonSourceType = "book" | "file";

export interface CanonImportGuard {
  readonly sourceType: CanonSourceType;
  readonly targetBookId: string;
  readonly sourceBookId: string;
  readonly hasSourceFile: boolean;
}

/** True when the canon import form is ready to be submitted. */
export function canSubmitCanonImport(input: CanonImportGuard): boolean {
  if (!input.targetBookId) return false;
  if (input.sourceType === "book") {
    if (!input.sourceBookId) return false;
    if (input.sourceBookId === input.targetBookId) return false;
    return true;
  }
  return Boolean(input.hasSourceFile);
}

/** Distinguishes the source/target collision from a missing target. */
export function canonImportSourceEqualsTarget(input: CanonImportGuard): boolean {
  return (
    input.sourceType === "book"
    && Boolean(input.sourceBookId)
    && input.sourceBookId === input.targetBookId
  );
}
