import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { buildExportArtifact, type ExportStateLike } from "../interaction/export-artifact.js";
import JSZip from "jszip";

const TEST_ROOT = join(process.cwd(), ".tmp-export-test");

describe("buildExportArtifact", () => {
  const mockState: ExportStateLike = {
    bookDir: (bookId: string) => join(TEST_ROOT, "books", bookId),
    loadBookConfig: async (bookId: string) => ({
      title: `Test Book ${bookId}`,
      language: "en",
    }),
    loadChapterIndex: async () => [
      { number: 1, status: "approved", wordCount: 500 },
      { number: 2, status: "approved", wordCount: 600 },
      { number: 3, status: "drafted", wordCount: 400 },
    ],
  };

  beforeEach(async () => {
    await mkdir(join(TEST_ROOT, "books", "test-book", "chapters"), { recursive: true });
    await writeFile(
      join(TEST_ROOT, "books", "test-book", "chapters", "0001-chapter-one.md"),
      "# Chapter One\n\nThis is the first chapter.",
    );
    await writeFile(
      join(TEST_ROOT, "books", "test-book", "chapters", "0002-chapter-two.md"),
      "# Chapter Two\n\nThis is the second chapter.",
    );
    await writeFile(
      join(TEST_ROOT, "books", "test-book", "chapters", "0003-chapter-three.md"),
      "# Chapter Three\n\nThis is the third chapter.",
    );
  });

  afterEach(async () => {
    await rm(TEST_ROOT, { recursive: true, force: true });
  });

  it("exports single TXT file", async () => {
    const artifact = await buildExportArtifact(mockState, "test-book", {
      format: "txt",
      packaging: "single",
    });

    expect(artifact.format).toBe("txt");
    expect(artifact.packaging).toBe("single");
    expect(artifact.chaptersExported).toBe(3);
    expect(artifact.totalWords).toBe(1500);
    expect(artifact.contentType).toContain("text/plain");
    expect(typeof artifact.payload).toBe("string");
    expect(artifact.payload).toContain("Test Book test-book");
    expect(artifact.payload).toContain("Chapter One");
  });

  it("exports single Markdown file", async () => {
    const artifact = await buildExportArtifact(mockState, "test-book", {
      format: "md",
      packaging: "single",
    });

    expect(artifact.format).toBe("md");
    expect(artifact.packaging).toBe("single");
    expect(artifact.contentType).toContain("text/markdown");
    expect(artifact.payload).toContain("# Test Book test-book");
  });

  it("exports chapters as ZIP", async () => {
    const artifact = await buildExportArtifact(mockState, "test-book", {
      format: "txt",
      packaging: "chapters",
    });

    expect(artifact.format).toBe("txt");
    expect(artifact.packaging).toBe("chapters");
    expect(artifact.chaptersExported).toBe(3);
    expect(artifact.contentType).toBe("application/zip");
    expect(artifact.fileName).toBe("test-book-chapters.zip");
    expect(Buffer.isBuffer(artifact.payload)).toBe(true);

    const zip = await JSZip.loadAsync(artifact.payload as Buffer);
    const files = Object.keys(zip.files);

    expect(files).toContain("0001.txt");
    expect(files).toContain("0002.txt");
    expect(files).toContain("0003.txt");
    expect(files).toContain("book.json");

    const manifest = JSON.parse(await zip.file("book.json")!.async("string"));
    expect(manifest.title).toBe("Test Book test-book");
    expect(manifest.format).toBe("txt");
    expect(manifest.packaging).toBe("chapters");
    expect(manifest.chaptersExported).toBe(3);
    expect(manifest.totalWords).toBe(1500);
    expect(manifest.chapters).toHaveLength(3);
  });

  it("exports chapters as ZIP (Markdown)", async () => {
    const artifact = await buildExportArtifact(mockState, "test-book", {
      format: "md",
      packaging: "chapters",
    });

    expect(artifact.format).toBe("md");
    const zip = await JSZip.loadAsync(artifact.payload as Buffer);
    const files = Object.keys(zip.files);

    expect(files).toContain("0001.md");
    expect(files).toContain("0002.md");
    expect(files).toContain("0003.md");
  });

  it("filters approved-only chapters", async () => {
    const artifact = await buildExportArtifact(mockState, "test-book", {
      format: "txt",
      packaging: "single",
      approvedOnly: true,
    });

    expect(artifact.chaptersExported).toBe(2);
    expect(artifact.totalWords).toBe(1100);
    expect(artifact.payload).toContain("Chapter One");
    expect(artifact.payload).toContain("Chapter Two");
    expect(artifact.payload).not.toContain("Chapter Three");
  });

  it("filters approved-only chapters in ZIP", async () => {
    const artifact = await buildExportArtifact(mockState, "test-book", {
      format: "txt",
      packaging: "chapters",
      approvedOnly: true,
    });

    expect(artifact.chaptersExported).toBe(2);

    const zip = await JSZip.loadAsync(artifact.payload as Buffer);
    const files = Object.keys(zip.files);

    expect(files).toContain("0001.txt");
    expect(files).toContain("0002.txt");
    expect(files).not.toContain("0003.txt");

    const manifest = JSON.parse(await zip.file("book.json")!.async("string"));
    expect(manifest.approvedOnly).toBe(true);
    expect(manifest.chaptersExported).toBe(2);
  });

  it("rejects chapters packaging for EPUB", async () => {
    await expect(
      buildExportArtifact(mockState, "test-book", {
        format: "epub",
        packaging: "chapters",
      }),
    ).rejects.toThrow("EPUB export only supports single-file packaging");
  });

  it("exports EPUB as single file", async () => {
    const artifact = await buildExportArtifact(mockState, "test-book", {
      format: "epub",
      packaging: "single",
    });

    expect(artifact.format).toBe("epub");
    expect(artifact.packaging).toBe("single");
    expect(artifact.contentType).toBe("application/epub+zip");
    expect(Buffer.isBuffer(artifact.payload)).toBe(true);
  });

  it("defaults to single packaging", async () => {
    const artifact = await buildExportArtifact(mockState, "test-book", {
      format: "txt",
    });

    expect(artifact.packaging).toBe("single");
    expect(typeof artifact.payload).toBe("string");
  });
});
