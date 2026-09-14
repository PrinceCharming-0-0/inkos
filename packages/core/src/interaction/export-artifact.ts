import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { EPub } from "epub-gen-memory";
import JSZip from "jszip";

export type ExportPackaging = "single" | "chapters";

export interface ExportStateLike {
  readonly bookDir: (bookId: string) => string;
  readonly loadBookConfig: (bookId: string) => Promise<{ readonly title: string; readonly language?: string }>;
  readonly loadChapterIndex: (bookId: string) => Promise<ReadonlyArray<{
    readonly number: number;
    readonly status: string;
    readonly wordCount: number;
  }>>;
}

export interface ExportArtifact {
  readonly outputPath: string;
  readonly fileName: string;
  readonly chaptersExported: number;
  readonly totalWords: number;
  readonly format: "txt" | "md" | "epub";
  readonly contentType: string;
  readonly payload: string | Buffer;
  readonly packaging?: ExportPackaging;
}

function buildChapterFileLookup(files: ReadonlyArray<string>): ReadonlyMap<number, string> {
  const lookup = new Map<number, string>();
  for (const file of files) {
    if (!file.endsWith(".md") || !/^\d{4}/.test(file)) {
      continue;
    }
    const chapterNumber = parseInt(file.slice(0, 4), 10);
    if (!lookup.has(chapterNumber)) {
      lookup.set(chapterNumber, file);
    }
  }
  return lookup;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function markdownToSimpleHtml(markdown: string): { title: string; html: string } {
  const title = markdown.match(/^#\s+(.+)/m)?.[1]?.trim() ?? "Untitled Chapter";
  const html = markdown
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("\n");
  return { title, html };
}

async function buildChaptersZipArtifact(
  state: ExportStateLike,
  bookId: string,
  book: { readonly title: string; readonly language?: string },
  chapters: ReadonlyArray<{ readonly number: number; readonly status: string; readonly wordCount: number }>,
  chapterFiles: ReadonlyMap<number, string>,
  chaptersDir: string,
  format: "txt" | "md",
  approvedOnly: boolean,
  totalWords: number,
): Promise<{ readonly payload: Buffer; readonly chaptersExported: number }> {
  const zip = new JSZip();
  const manifest: Array<{ number: number; fileName: string; wordCount: number }> = [];

  for (const chapter of chapters) {
    const match = chapterFiles.get(chapter.number);
    if (!match) continue;

    const markdown = await readFile(join(chaptersDir, match), "utf-8");
    const fileName = format === "md"
      ? `${String(chapter.number).padStart(4, "0")}.md`
      : `${String(chapter.number).padStart(4, "0")}.txt`;

    zip.file(fileName, markdown);
    manifest.push({ number: chapter.number, fileName, wordCount: chapter.wordCount });
  }

  zip.file("book.json", JSON.stringify({
    title: book.title,
    language: book.language,
    format,
    packaging: "chapters",
    approvedOnly,
    chaptersExported: manifest.length,
    totalWords,
    exportedAt: new Date().toISOString(),
    chapters: manifest,
  }, null, 2));

  return {
    payload: await zip.generateAsync({ type: "nodebuffer" }),
    chaptersExported: manifest.length,
  };
}

export async function buildExportArtifact(
  state: ExportStateLike,
  bookId: string,
  options: {
    readonly format?: "txt" | "md" | "epub";
    readonly approvedOnly?: boolean;
    readonly outputPath?: string;
    readonly packaging?: ExportPackaging;
  },
): Promise<ExportArtifact> {
  const format = options.format ?? "txt";
  const packaging = options.packaging ?? "single";

  if (packaging === "chapters" && format === "epub") {
    throw new Error("EPUB export only supports single-file packaging.");
  }

  const index = await state.loadChapterIndex(bookId);
  const book = await state.loadBookConfig(bookId);
  const chapters = options.approvedOnly
    ? index.filter((chapter) => chapter.status === "approved")
    : index;

  if (chapters.length === 0) {
    throw new Error("No chapters to export.");
  }

  const bookDir = state.bookDir(bookId);
  const chaptersDir = join(bookDir, "chapters");
  const projectRoot = dirname(dirname(bookDir));
  const outputPath = options.outputPath ?? join(projectRoot, `${bookId}_export.${format}`);
  const chapterFiles = buildChapterFileLookup(await readdir(chaptersDir));
  const totalWords = chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0);

  if (format === "epub") {
    const epubChapters: Array<{ title: string; content: string }> = [];
    for (const chapter of chapters) {
      const match = chapterFiles.get(chapter.number);
      if (!match) {
        continue;
      }
      const markdown = await readFile(join(chaptersDir, match), "utf-8");
      const { title, html } = markdownToSimpleHtml(markdown);
      epubChapters.push({ title, content: html });
    }
    const epubInstance = new EPub(
      { title: book.title, lang: book.language === "en" ? "en" : "zh-CN" },
      epubChapters,
    );
    return {
      outputPath,
      fileName: `${bookId}.epub`,
      chaptersExported: chapters.length,
      totalWords,
      format,
      contentType: "application/epub+zip",
      payload: await epubInstance.genEpub(),
      packaging: "single",
    };
  }

  if (packaging === "chapters") {
    const zip = await buildChaptersZipArtifact(
      state,
      bookId,
      book,
      chapters,
      chapterFiles,
      chaptersDir,
      format,
      options.approvedOnly ?? false,
      totalWords,
    );
    return {
      outputPath,
      fileName: `${bookId}-chapters.zip`,
      chaptersExported: zip.chaptersExported,
      totalWords,
      format,
      contentType: "application/zip",
      payload: zip.payload,
      packaging: "chapters",
    };
  }

  const parts: string[] = [];
  parts.push(format === "md" ? `# ${book.title}\n\n---\n` : `${book.title}\n\n`);
  for (const chapter of chapters) {
    const match = chapterFiles.get(chapter.number);
    if (!match) {
      continue;
    }
    parts.push(await readFile(join(chaptersDir, match), "utf-8"));
    parts.push("\n\n");
  }

  return {
    outputPath,
    fileName: `${bookId}.${format}`,
    chaptersExported: chapters.length,
    totalWords,
    format,
    contentType: format === "md" ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8",
    payload: parts.join(format === "md" ? "\n---\n\n" : "\n"),
    packaging: "single",
  };
}

export async function writeExportArtifact(
  state: ExportStateLike,
  bookId: string,
  options: {
    readonly format?: "txt" | "md" | "epub";
    readonly approvedOnly?: boolean;
    readonly outputPath?: string;
    readonly packaging?: ExportPackaging;
  },
): Promise<Omit<ExportArtifact, "payload" | "contentType" | "fileName">> {
  const artifact = await buildExportArtifact(state, bookId, options);
  await mkdir(dirname(artifact.outputPath), { recursive: true });
  await writeFile(artifact.outputPath, artifact.payload);
  return {
    outputPath: artifact.outputPath,
    chaptersExported: artifact.chaptersExported,
    totalWords: artifact.totalWords,
    format: artifact.format,
    packaging: artifact.packaging,
  };
}
