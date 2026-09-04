import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { buildExportArtifact, writeExportArtifact } from "../interaction/export-artifact.js";
import type { ExportStateLike } from "../interaction/export-artifact.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inkos-export-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function makeState(root: string, chapterNumbers: number[]): ExportStateLike {
  return {
    bookDir: (bookId: string) => join(root, "books", bookId),
    loadBookConfig: async () => ({ title: "测试之书", language: "zh" }),
    loadChapterIndex: async () =>
      chapterNumbers.map((number) => ({
        number,
        status: "approved",
        wordCount: 100 + number,
      })),
  };
}

async function seedChapter(root: string, bookId: string, number: number, markdown: string) {
  const dir = join(root, "books", bookId, "chapters");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${String(number).padStart(4, "0")}.md`), markdown, "utf-8");
}

describe("buildExportArtifact — chapters packaging", () => {
  it("builds a zip with per-chapter files in numeric order plus book.json metadata", async () => {
    const root = await makeTempRoot();
    await seedChapter(root, "demo", 2, "# 第二章 风起\n\n正文二。");
    await seedChapter(root, "demo", 1, "# 第一章 序幕\n\n正文一。");
    await seedChapter(root, "demo", 11, "# 第十一章 回响\n\n正文十一。");

    const artifact = await buildExportArtifact(makeState(root, [1, 2, 11]), "demo", {
      format: "md",
      packaging: "chapters",
    });

    expect(artifact.format).toBe("md");
    expect(artifact.contentType).toBe("application/zip");
    expect(artifact.fileName).toBe("demo-chapters.zip");
    expect(artifact.chaptersExported).toBe(3);

    const zip = await JSZip.loadAsync(artifact.payload as Buffer);
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();

    // Chapter files use zero-padded numbers so lexicographic order matches
    // numeric chapter order — the same convention the importer reads back.
    expect(names).toEqual([
      "book.json",
      "chapters/0001-第一章 序幕.md",
      "chapters/0002-第二章 风起.md",
      "chapters/0011-第十一章 回响.md",
    ]);

    const meta = JSON.parse(await zip.file("book.json")!.async("string"));
    expect(meta).toMatchObject({
      bookId: "demo",
      title: "测试之书",
      packaging: "chapters",
      chaptersExported: 3,
    });
    expect(meta.chapters.map((c: { number: number }) => c.number)).toEqual([1, 2, 11]);
    expect(meta.chapters[0]).toMatchObject({
      title: "第一章 序幕",
      file: "chapters/0001-第一章 序幕.md",
      wordCount: 101,
    });

    const firstChapter = await zip.file("chapters/0001-第一章 序幕.md")!.async("string");
    expect(firstChapter).toContain("正文一。");
  });

  it("respects approvedOnly filtering", async () => {
    const root = await makeTempRoot();
    await seedChapter(root, "demo", 1, "# 一\n\na");
    await seedChapter(root, "demo", 2, "# 二\n\nb");

    const state: ExportStateLike = {
      bookDir: (bookId: string) => join(root, "books", bookId),
      loadBookConfig: async () => ({ title: "T" }),
      loadChapterIndex: async () => [
        { number: 1, status: "drafted", wordCount: 1 },
        { number: 2, status: "approved", wordCount: 1 },
      ],
    };

    const artifact = await buildExportArtifact(state, "demo", {
      format: "txt",
      packaging: "chapters",
      approvedOnly: true,
    });

    expect(artifact.chaptersExported).toBe(1);
    const zip = await JSZip.loadAsync(artifact.payload as Buffer);
    const fileNames = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
    expect(fileNames).toContain("chapters/0002-二.txt");
    expect(fileNames).not.toContain("chapters/0001-一.txt");
  });

  it("throws for epub + chapters packaging", async () => {
    const root = await makeTempRoot();
    await seedChapter(root, "demo", 1, "# 一\n\na");
    await expect(
      buildExportArtifact(makeState(root, [1]), "demo", { format: "epub", packaging: "chapters" }),
    ).rejects.toThrow(/single-file/i);
  });

  it("writeExportArtifact writes the zip to the requested path", async () => {
    const root = await makeTempRoot();
    await seedChapter(root, "demo", 1, "# 一\n\na");
    const outputPath = join(root, "out", "demo.zip");

    const result = await writeExportArtifact(makeState(root, [1]), "demo", {
      format: "md",
      packaging: "chapters",
      outputPath,
    });

    expect(result.outputPath).toBe(outputPath);
    expect(result.chaptersExported).toBe(1);
    const siblings = await readdir(join(root, "out"));
    expect(siblings).toEqual(["demo.zip"]);
  });
});
