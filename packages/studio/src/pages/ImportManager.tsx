import { useEffect, useState } from "react";
import { fetchJson, invalidateApiPaths, useApi, postApi } from "../hooks/use-api";
import type { useSSE } from "../hooks/use-sse";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useI18n } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import { tr } from "../lib/app-language";
import { FileInput, BookCopy, Feather, BookMarked, Upload, Wand2, BookPlus } from "lucide-react";
import { ImportWizard } from "./ImportWizard";
import { waitForStudioBookReady } from "../lib/book-ready";

interface BookSummary {
  readonly id: string;
  readonly title: string;
}

interface Nav { toDashboard: () => void; toBook: (bookId: string) => void }

type Tab = "book" | "chapters" | "canon" | "fanfic" | "spinoff" | "imitation";

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

type SseState = ReturnType<typeof useSSE>;

export function ImportManager({ nav, theme, t, initialTab, sse }: { nav: Nav; theme: Theme; t: TFunction; initialTab?: Tab; sse: SseState }) {
  const c = useColors(theme);
  const { lang } = useI18n();
  const { data: booksData } = useApi<{ books: ReadonlyArray<BookSummary> }>("/books");
  const [tab, setTab] = useState<Tab>(initialTab ?? "chapters");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);

  // Chapters state
  const [chText, setChText] = useState("");
  const [chBookId, setChBookId] = useState("");
  const [chSplitRegex, setChSplitRegex] = useState("");

  // Canon state
  const [canonTarget, setCanonTarget] = useState("");
  const [canonFrom, setCanonFrom] = useState("");
  const [canonSourceType, setCanonSourceType] = useState<"book" | "file">("book");
  const [canonFile, setCanonFile] = useState<File | null>(null);

  // Fanfic state
  const [ffTitle, setFfTitle] = useState("");
  const [ffText, setFfText] = useState("");
  const [ffMode, setFfMode] = useState("canon");
  const [ffGenre, setFfGenre] = useState("other");
  const [ffLang, setFfLang] = useState(lang);

  // Spinoff (番外) state
  const [spTitle, setSpTitle] = useState("");
  const [spParent, setSpParent] = useState("");
  const [spDirection, setSpDirection] = useState("");

  // Imitation (仿写) state
  const [imTitle, setImTitle] = useState("");
  const [imRef, setImRef] = useState("");
  const [imIdea, setImIdea] = useState("");
  const [imGenre, setImGenre] = useState("other");
  const [imLang, setImLang] = useState(lang);

  useEffect(() => {
    if (initialTab) {
      setTab(initialTab);
      setStatus("");
    }
  }, [initialTab]);

  const handleImportChapters = async () => {
    if (!chText.trim() || !chBookId) return;
    setLoading(true);
    setStatus("");
    try {
      const data = await fetchJson<{ importedCount?: number }>(`/books/${chBookId}/import/chapters`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: chText, splitRegex: chSplitRegex || undefined }),
      });
      setStatus(`Imported ${data.importedCount} chapters`);
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    setLoading(false);
  };

  const handleImportCanon = async () => {
    if (!canonTarget || (canonSourceType === "book" ? !canonFrom : !canonFile)) return;
    setLoading(true);
    setStatus("");
    try {
      if (canonSourceType === "book") {
        await postApi(`/books/${canonTarget}/import/canon`, { fromBookId: canonFrom });
      } else if (canonFile) {
        const uploaded = await fetchJson<{ storedPath: string }>("/import/canon/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: canonFile.name, dataUrl: await fileToDataUrl(canonFile) }),
        });
        await postApi(`/books/${canonTarget}/import/canon-file`, {
          filePath: uploaded.storedPath,
          filename: canonFile.name,
        });
      }
      setStatus(tr("母本导入成功", "Canon imported successfully"));
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    setLoading(false);
  };

  const handleFanficInit = async () => {
    if (!ffTitle.trim() || !ffText.trim()) return;
    setLoading(true);
    setStatus("");
    try {
      const data = await fetchJson<{ bookId?: string }>("/fanfic/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: ffTitle, sourceText: ffText, mode: ffMode,
          genre: ffGenre, language: ffLang,
        }),
      });
      if (data.bookId) {
        setStatus(`${t("import.creating")}: ${data.bookId}`);
        await waitForStudioBookReady(data.bookId);
        setStatus(`${t("import.fanficDone")}: ${data.bookId}`);
        invalidateApiPaths(["/api/v1/books", `/api/v1/books/${data.bookId}`]);
        nav.toBook(data.bookId);
      }
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    setLoading(false);
  };

  const handleSpinoffInit = async () => {
    if (!spTitle.trim() || !spParent) return;
    setLoading(true);
    setStatus("");
    try {
      const data = await postApi<{ bookId?: string }>("/spinoff/init", { title: spTitle, parentBookId: spParent, direction: spDirection || undefined });
      if (data.bookId) {
        setStatus(`${t("import.creating")}: ${data.bookId}`);
        await waitForStudioBookReady(data.bookId);
        setStatus(`${t("import.spinoffDone")}: ${data.bookId}`);
        invalidateApiPaths(["/api/v1/books", `/api/v1/books/${data.bookId}`]);
        nav.toBook(data.bookId);
      }
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    setLoading(false);
  };

  const handleImitationInit = async () => {
    if (!imTitle.trim() || !imRef.trim() || !imIdea.trim()) return;
    setLoading(true);
    setStatus("");
    try {
      const data = await postApi<{ bookId?: string }>("/imitation/init", { title: imTitle, referenceText: imRef, storyIdea: imIdea, genre: imGenre, language: imLang });
      if (data.bookId) {
        setStatus(`${t("import.creating")}: ${data.bookId}`);
        await waitForStudioBookReady(data.bookId);
        setStatus(`${t("import.imitationDone")}: ${data.bookId}`);
        invalidateApiPaths(["/api/v1/books", `/api/v1/books/${data.bookId}`]);
        nav.toBook(data.bookId);
      }
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    setLoading(false);
  };

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "book", label: tr("导入已有作品", "Import existing work"), icon: <BookPlus size={14} /> },
    { id: "chapters", label: t("import.chapters"), icon: <FileInput size={14} /> },
    { id: "canon", label: t("import.canon"), icon: <BookCopy size={14} /> },
    { id: "fanfic", label: t("import.fanfic"), icon: <Feather size={14} /> },
    { id: "spinoff", label: t("import.spinoff"), icon: <BookMarked size={14} /> },
    { id: "imitation", label: t("import.imitation"), icon: <Wand2 size={14} /> },
  ];

  // UX-01: every disabled primary action states why, in plain words.
  const chaptersDisabledReason = !chBookId
    ? tr("请先选择要追加章节的目标书籍", "Select a target book first")
    : !chText.trim()
      ? tr("请粘贴章节文本", "Paste chapter text first")
      : null;
  const canonDisabledReason = !canonTarget
    ? tr("请选择要绑定母本的衍生作品（目标书籍）", "Select the derivative work (target book) to bind the canon to")
    : canonSourceType === "book"
      ? (!canonFrom ? tr("请选择母本来源书籍", "Select the canon source book first") : null)
      : (!canonFile ? tr("请先上传母本文件", "Upload the canon file first") : null);
  const fanficDisabledReason = !ffTitle.trim()
    ? tr("请填写同人标题", "Enter the fanfic title first")
    : !ffText.trim()
      ? tr("请粘贴原作文本/设定资料", "Paste source material first")
      : null;
  const spinoffDisabledReason = !spTitle.trim()
    ? tr("请填写番外标题", "Enter the side-story title first")
    : !spParent
      ? tr("请选择正传母书", "Select the parent book first")
      : null;
  const imitationDisabledReason = !imTitle.trim()
    ? tr("请填写新书标题", "Enter the new book title first")
    : !imRef.trim()
      ? tr("请粘贴参考作品文本", "Paste the reference text first")
      : !imIdea.trim()
        ? tr("请填写原创故事梗概", "Enter your story idea first")
        : null;

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <button onClick={nav.toDashboard} className={c.link}>{t("bread.home")}</button>
        <span className="text-border">/</span>
        <span>{t("nav.import")}</span>
      </div>

      <h1 className="font-serif text-3xl flex items-center gap-3">
        <FileInput size={28} className="text-primary" />
        {t("import.title")}
      </h1>

      {/* Tabs */}
      <div className="flex gap-1 bg-secondary/30 rounded-lg p-1 w-fit">
        {tabs.map((tb) => (
          <button
            key={tb.id}
            onClick={() => { setTab(tb.id); setStatus(""); }}
            className={`px-4 py-2 rounded-md text-sm font-medium flex items-center gap-2 transition-all ${
              tab === tb.id ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tb.icon} {tb.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className={`border ${c.cardStatic} rounded-lg p-6 space-y-4`}>
        {tab === "book" && <ImportWizard nav={nav} theme={theme} sse={sse} />}

        {tab === "chapters" && (
          <>
            <select value={chBookId} onChange={(e) => setChBookId(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm">
              <option value="">{t("import.selectTarget")}</option>
              {booksData?.books.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
            </select>
            <input
              type="text" value={chSplitRegex} onChange={(e) => setChSplitRegex(e.target.value)}
              placeholder={t("import.splitRegex")}
              className="w-full px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm font-mono"
            />
            <textarea value={chText} onChange={(e) => setChText(e.target.value)} rows={10}
              placeholder={t("import.pasteChapters")}
              className="w-full px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm resize-none font-mono"
            />
            {chaptersDisabledReason && <p className="text-xs text-muted-foreground">{chaptersDisabledReason}</p>}
            <button onClick={handleImportChapters} disabled={loading || !chBookId || !chText.trim()}
              title={chaptersDisabledReason ?? undefined}
              className={`px-4 py-2 text-sm rounded-lg ${c.btnPrimary} disabled:opacity-30`}>
              {loading ? t("import.importing") : t("import.chapters")}
            </button>
          </>
        )}

        {tab === "canon" && (
          <>
            <p className="text-sm text-muted-foreground">
              {tr("为衍生作品绑定母本：选择母本来源（已有 InkOS 书籍或外部 TXT/Markdown/PDF 文件），再选择要绑定到的目标书籍。绑定后母本将作为该书的正典参照。", "Bind a canon to a derivative work: choose the canon source (an existing InkOS book, or an external TXT/Markdown/PDF file) and the target book to bind it to. The bound canon becomes the book's canon reference.")}
            </p>
            <div className="inline-flex rounded-lg border border-border bg-secondary/20 p-1">
              {(["book", "file"] as const).map((sourceType) => (
                <button
                  key={sourceType}
                  type="button"
                  onClick={() => setCanonSourceType(sourceType)}
                  className={`rounded-md px-3 py-1.5 text-sm ${canonSourceType === sourceType ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}
                >
                  {sourceType === "book" ? tr("已有书籍", "Existing book") : tr("上传外部母本", "Upload external canon")}
                </button>
              ))}
            </div>
            {canonSourceType === "book" ? (
              <select value={canonFrom} onChange={(e) => setCanonFrom(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm">
                <option value="">{t("import.selectSource")}</option>
                {booksData?.books.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
              </select>
            ) : (
              <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-border bg-secondary/20 px-4 py-4 text-sm hover:bg-secondary/30">
                <Upload size={18} className="text-primary" />
                <span className="min-w-0 flex-1 truncate">
                  {canonFile?.name ?? tr("选择 TXT、Markdown 或 PDF 文件", "Choose a TXT, Markdown, or PDF file")}
                </span>
                <input
                  type="file"
                  accept=".txt,.md,.markdown,.pdf,text/plain,text/markdown,application/pdf"
                  className="sr-only"
                  onChange={(event) => setCanonFile(event.target.files?.[0] ?? null)}
                />
              </label>
            )}
            <p className="text-xs text-muted-foreground">
              {tr("目标书籍：绑定到哪本衍生作品", "Target book: the derivative work to bind the canon to")}
            </p>
            <select value={canonTarget} onChange={(e) => setCanonTarget(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm">
              <option value="">{t("import.selectDerivative")}</option>
              {booksData?.books.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
            </select>
            {canonDisabledReason && <p className="text-xs text-amber-600">{canonDisabledReason}</p>}
            <button onClick={handleImportCanon} disabled={loading || !canonTarget || (canonSourceType === "book" ? !canonFrom : !canonFile)}
              title={canonDisabledReason ?? undefined}
              className={`px-4 py-2 text-sm rounded-lg ${c.btnPrimary} disabled:opacity-30`}>
              {loading ? t("import.importing") : tr("绑定母本", "Bind canon")}
            </button>
          </>
        )}

        {tab === "fanfic" && (
          <>
            <input type="text" value={ffTitle} onChange={(e) => setFfTitle(e.target.value)}
              placeholder={t("import.fanficTitle")}
              className="w-full px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm"
            />
            <div className="grid grid-cols-3 gap-3">
              <select value={ffMode} onChange={(e) => setFfMode(e.target.value)}
                className="px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm">
                <option value="canon">{tr("原著向", "Canon-compliant")}</option>
                <option value="au">{tr("架空 AU", "Alternate Universe (AU)")}</option>
                <option value="ooc">{tr("性格偏离 OOC", "Out of Character (OOC)")}</option>
                <option value="cp">{tr("配对 CP", "Pairing (CP)")}</option>
              </select>
              <select value={ffGenre} onChange={(e) => setFfGenre(e.target.value)}
                className="px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm">
                <option value="other">{tr("其他", "Other")}</option>
                <option value="xuanhuan">{tr("玄幻", "Xuanhuan Fantasy")}</option>
                <option value="urban">{tr("都市", "Urban")}</option>
                <option value="xianxia">{tr("仙侠", "Xianxia")}</option>
              </select>
              <select value={ffLang} onChange={(e) => setFfLang(e.target.value as "zh" | "en")}
                className="px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm">
                <option value="zh">{tr("中文", "Chinese")}</option>
                <option value="en">English</option>
              </select>
            </div>
            <textarea value={ffText} onChange={(e) => setFfText(e.target.value)} rows={10}
              placeholder={t("import.pasteMaterial")}
              className="w-full px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm resize-none font-mono"
            />
            {fanficDisabledReason && <p className="text-xs text-muted-foreground">{fanficDisabledReason}</p>}
            <button onClick={handleFanficInit} disabled={loading || !ffTitle.trim() || !ffText.trim()}
              title={fanficDisabledReason ?? undefined}
              className={`px-4 py-2 text-sm rounded-lg ${c.btnPrimary} disabled:opacity-30`}>
              {loading ? t("import.creating") : t("import.fanfic")}
            </button>
          </>
        )}

        {tab === "spinoff" && (
          <>
            <p className="text-xs text-muted-foreground">{t("import.spinoffHint")}</p>
            <input type="text" value={spTitle} onChange={(e) => setSpTitle(e.target.value)}
              placeholder={t("import.spinoffTitle")}
              className="w-full px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm"
            />
            <select value={spParent} onChange={(e) => setSpParent(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm">
              <option value="">{t("import.selectParent")}</option>
              {booksData?.books.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
            </select>
            <textarea value={spDirection} onChange={(e) => setSpDirection(e.target.value)} rows={5}
              placeholder={t("import.spinoffDirection")}
              className="w-full px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm resize-none"
            />
            {spinoffDisabledReason && <p className="text-xs text-muted-foreground">{spinoffDisabledReason}</p>}
            <button onClick={handleSpinoffInit} disabled={loading || !spTitle.trim() || !spParent}
              title={spinoffDisabledReason ?? undefined}
              className={`px-4 py-2 text-sm rounded-lg ${c.btnPrimary} disabled:opacity-30`}>
              {loading ? t("import.creating") : t("import.spinoff")}
            </button>
          </>
        )}

        {tab === "imitation" && (
          <>
            <p className="text-xs text-muted-foreground">{t("import.imitationHint")}</p>
            <input type="text" value={imTitle} onChange={(e) => setImTitle(e.target.value)}
              placeholder={t("import.imitationTitle")}
              className="w-full px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm"
            />
            <div className="grid grid-cols-2 gap-3">
              <select value={imGenre} onChange={(e) => setImGenre(e.target.value)}
                className="px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm">
                <option value="other">{tr("其他", "Other")}</option>
                <option value="xuanhuan">{tr("玄幻", "Xuanhuan Fantasy")}</option>
                <option value="urban">{tr("都市", "Urban")}</option>
                <option value="xianxia">{tr("仙侠", "Xianxia")}</option>
              </select>
              <select value={imLang} onChange={(e) => setImLang(e.target.value as "zh" | "en")}
                className="px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm">
                <option value="zh">{tr("中文", "Chinese")}</option>
                <option value="en">English</option>
              </select>
            </div>
            <textarea value={imIdea} onChange={(e) => setImIdea(e.target.value)} rows={4}
              placeholder={t("import.imitationIdea")}
              className="w-full px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm resize-none"
            />
            <textarea value={imRef} onChange={(e) => setImRef(e.target.value)} rows={8}
              placeholder={t("import.imitationRef")}
              className="w-full px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm resize-none font-mono"
            />
            {imitationDisabledReason && <p className="text-xs text-muted-foreground">{imitationDisabledReason}</p>}
            <button onClick={handleImitationInit} disabled={loading || !imTitle.trim() || !imRef.trim() || !imIdea.trim()}
              title={imitationDisabledReason ?? undefined}
              className={`px-4 py-2 text-sm rounded-lg ${c.btnPrimary} disabled:opacity-30`}>
              {loading ? t("import.creating") : t("import.imitation")}
            </button>
          </>
        )}

        {status && (
          <div className={`text-sm px-3 py-2 rounded-lg ${status.startsWith("Error") ? "bg-destructive/10 text-destructive" : "bg-emerald-500/10 text-emerald-600"}`}>
            {status}
          </div>
        )}
      </div>
    </div>
  );
}
