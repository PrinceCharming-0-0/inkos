import { describe, expect, it } from "vitest";
import {
  canSubmitCanonImport,
  canonImportSourceEqualsTarget,
  type CanonImportGuard,
} from "./import-manager-state";

const baseGuard = (overrides: Partial<CanonImportGuard> = {}): CanonImportGuard => ({
  sourceType: "book",
  targetBookId: "target-book",
  sourceBookId: "source-book",
  hasSourceFile: false,
  ...overrides,
});

describe("canSubmitCanonImport", () => {
  it("allows the import when source and target are different books", () => {
    expect(canSubmitCanonImport(baseGuard())).toBe(true);
  });

  it("blocks the import when the source book equals the target book", () => {
    expect(
      canSubmitCanonImport(baseGuard({ sourceBookId: "same-book", targetBookId: "same-book" })),
    ).toBe(false);
  });

  it("keeps the button disabled when the book list is empty (no target)", () => {
    expect(
      canSubmitCanonImport(baseGuard({ targetBookId: "", sourceBookId: "source-book" })),
    ).toBe(false);
  });

  it("keeps the button disabled when the book source is missing", () => {
    expect(
      canSubmitCanonImport(baseGuard({ sourceBookId: "" })),
    ).toBe(false);
  });

  it("allows the import when a file source is attached to any target", () => {
    expect(
      canSubmitCanonImport(
        baseGuard({ sourceType: "file", targetBookId: "any-book", hasSourceFile: true }),
      ),
    ).toBe(true);
  });

  it("keeps the button disabled when the file source is missing", () => {
    expect(
      canSubmitCanonImport(
        baseGuard({ sourceType: "file", targetBookId: "any-book", hasSourceFile: false }),
      ),
    ).toBe(false);
  });
});

describe("canonImportSourceEqualsTarget", () => {
  it("flags the source/target collision only when both ids are set and equal", () => {
    expect(
      canonImportSourceEqualsTarget(
        baseGuard({ sourceBookId: "same", targetBookId: "same" }),
      ),
    ).toBe(true);
  });

  it("ignores the collision when the source is a file upload", () => {
    expect(
      canonImportSourceEqualsTarget(
        baseGuard({ sourceType: "file", sourceBookId: "same", targetBookId: "same" }),
      ),
    ).toBe(false);
  });

  it("ignores the collision when the source id is empty (empty book list case)", () => {
    expect(
      canonImportSourceEqualsTarget(baseGuard({ sourceBookId: "", targetBookId: "" })),
    ).toBe(false);
  });
});
