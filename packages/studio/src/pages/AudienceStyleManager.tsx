import { useEffect, useState } from "react";
import { Plus, Pencil, Trash2 } from "lucide-react";
import type { AudienceStyleTag } from "@actalk/inkos-core";
import { fetchJson, postApi, putApi, useApi } from "../hooks/use-api";
import type { Theme } from "../hooks/use-theme";
import type { StringKey, TFunction } from "../hooks/use-i18n";
import { audienceStyleStrings } from "../shared/audience-style-strings";
import { formatCommaSeparated, MixedCommaError, parseCommaSeparated, rememberCommaSeparated } from "../shared/comma-separated";
import { useColors } from "../hooks/use-colors";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { MessageResponse } from "../components/ai-elements/message";

const API = "/audience-style-tags";
const inputClass = "mt-1 w-full min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground normal-case tracking-normal disabled:opacity-50";
const labelClass = "block text-xs text-muted-foreground uppercase tracking-wide";
const multilineFields = ["description", "readerExperience", "narrativeStyle", "creativeBrief"] as const;
const listFields = ["relationshipAndElements", "avoidElements"] as const;
type Mode = "create" | "edit";
type TagFormData = Omit<AudienceStyleTag, typeof listFields[number]> & {
  relationshipAndElements: string;
  avoidElements: string;
};
interface Nav {
  toDashboard: () => void;
  toAudienceStyle: (tagId?: string, mode?: Mode) => void;
}

function toFormData(tag: AudienceStyleTag, projectRoot: string): TagFormData {
  return {
    ...tag,
    relationshipAndElements: formatCommaSeparated(tag.relationshipAndElements ?? [], projectRoot, "audience-style", tag.id, "relationshipAndElements"),
    avoidElements: formatCommaSeparated(tag.avoidElements ?? [], projectRoot, "audience-style", tag.id, "avoidElements"),
  };
}

function emptyTag(language: "zh" | "en"): TagFormData {
  return {
    id: "", name: "", kind: "audience", language,
    description: "", readerExperience: "", narrativeStyle: "",
    relationshipAndElements: "", avoidElements: "", creativeBrief: "",
  };
}

export function AudienceStyleManager({ route, nav, theme, t, language, projectRoot }: {
  route: { tagId?: string; mode?: Mode };
  nav: Nav;
  theme: Theme;
  t: TFunction;
  language: "zh" | "en";
  projectRoot: string;
}) {
  const c = useColors(theme);
  function localizedFailure(error: unknown, fallback: StringKey): string {
    const message = error instanceof Error ? error.message : error;
    const entry = Object.entries(audienceStyleStrings).find(([, value]) => value.zh === message || value.en === message);
    return t(entry ? entry[0] as StringKey : fallback);
  }
  const list = useApi<{ tags: AudienceStyleTag[] }>(API);
  const detail = useApi<{ tag: AudienceStyleTag }>(route.tagId ? `${API}/${encodeURIComponent(route.tagId)}` : "");
  const [filter, setFilter] = useState<"all" | "audience" | "style">("all");
  const [form, setForm] = useState<TagFormData>(() => emptyTag(language));
  const [initialized, setInitialized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AudienceStyleTag | null>(null);
  useEffect(() => {
    if (route.mode === "edit" && detail.data && !detail.loading && !detail.error && !initialized) {
      setForm(toFormData(detail.data.tag, projectRoot));
      setInitialized(true);
    }
  }, [route.mode, detail.data, detail.loading, detail.error, initialized, projectRoot]);

  const set = <K extends keyof TagFormData>(key: K, value: TagFormData[K]) => setForm((current) => ({ ...current, [key]: value }));
  const tags = list.data?.tags ?? [];
  const filtered = tags.filter((tag) => filter === "all" || tag.kind === filter);
  const selected = !detail.loading && !detail.error ? detail.data?.tag : undefined;

  async function save() {
    setFailure(null);
    setNotice(null);
    const id = form.id.trim();
    const name = form.name.trim();
    if (!id || /[/\\\0]/.test(id) || id.includes("..")) {
      setFailure(t("audienceStyle.invalidId"));
      return;
    }
    if (!name) {
      setFailure(t("audienceStyle.nameRequired"));
      return;
    }
    if (tags.some((tag) => tag.id === id && route.mode !== "edit")) {
      setFailure(t("audienceStyle.duplicateId"));
      return;
    }
    if (tags.some((tag) => tag.id !== (route.mode === "edit" ? route.tagId : undefined) && tag.name === name && tag.language === form.language)) {
      setFailure(t("audienceStyle.duplicateName"));
      return;
    }
    setBusy(true);
    try {
      const payload = {
        ...form, id, name,
        relationshipAndElements: parseCommaSeparated(form.relationshipAndElements),
        avoidElements: parseCommaSeparated(form.avoidElements),
      };
      if (route.mode === "edit") await putApi(`${API}/${encodeURIComponent(route.tagId!)}`, payload);
      else await postApi(`${API}/create`, payload);
      // Stay in the form to make successful persistence explicit and disable the saved id.
      for (const field of listFields) {
        rememberCommaSeparated(form[field], projectRoot, "audience-style", id, field);
      }
      setForm(toFormData(payload, projectRoot));
      setNotice(t("audienceStyle.saved"));
      if (route.mode === "create") {
        setInitialized(true);
        setSaveDialogOpen(true);
      }
      await list.refetch();
      if (route.mode === "edit") await detail.refetch();
    } catch (error) {
      setFailure(error instanceof MixedCommaError ? t("genre.mixedCommas") : localizedFailure(error, "audienceStyle.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function copy(tag: AudienceStyleTag) {
    setBusy(true);
    setFailure(null);
    setNotice(null);
    try {
      const result = await postApi<{ alreadyCopied: boolean }>(`${API}/${encodeURIComponent(tag.id)}/copy`);
      setNotice(t(result.alreadyCopied ? "audienceStyle.alreadyCopied" : "audienceStyle.copied"));
    } catch (error) {
      setFailure(localizedFailure(error, "audienceStyle.copyFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!deleteTarget) return;
    setBusy(true);
    setFailure(null);
    setNotice(null);
    try {
      await fetchJson(`${API}/${encodeURIComponent(deleteTarget.id)}`, { method: "DELETE" });
      setDeleteTarget(null);
      setNotice(t("audienceStyle.deleted"));
      await list.refetch();
      if (route.tagId) {
        alert(t("audienceStyle.deleted"));
        nav.toAudienceStyle();
      }
    } catch (error) {
      setDeleteTarget(null);
      setFailure(localizedFailure(error, "audienceStyle.deleteFailed"));
    } finally {
      setBusy(false);
    }
  }

  const actionButtons = (tag: AudienceStyleTag) => (
    <div className="flex min-w-0 max-w-full flex-wrap gap-2">
      <button
        disabled={busy}
        onClick={() => nav.toAudienceStyle(tag.id, "edit")}
        className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md ${c.btnSecondary}`}
      >
        <Pencil size={14} />{t("common.edit")}
      </button>
      <button
        disabled={busy}
        onClick={() => setDeleteTarget(tag)}
        className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md ${c.btnDanger}`}
      >
        <Trash2 size={14} />{t("common.delete")}
      </button>
      <button
        disabled={busy}
        onClick={() => void copy(tag)}
        title={t("audienceStyle.copyHint")}
        className={`px-3 py-1.5 text-sm rounded-md ${c.btnSecondary}`}
      >
        {t("audienceStyle.copy")}
      </button>
    </div>
  );

  return <div className="min-w-0 space-y-8 [overflow-wrap:anywhere]">
    <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
      <button onClick={nav.toDashboard} className={c.link}>{t("bread.home")}</button>
      <span className="text-border">/</span>
      {route.tagId || route.mode ? (
        <button onClick={() => nav.toAudienceStyle()} className={c.link}>{t("audienceStyle.title")}</button>
      ) : <span>{t("audienceStyle.title")}</span>}
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h1 className="min-w-0 font-serif text-3xl">{t("audienceStyle.title")}</h1>
      {!route.mode && <button onClick={() => nav.toAudienceStyle(undefined, "create")} className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md ${c.btnPrimary}`}><Plus size={16} />{t("audienceStyle.create")}</button>}
    </div>
    {notice && <p role="status" className="text-sm text-primary">{notice}</p>}
    {failure && <p role="alert" className="text-sm text-destructive">{failure}</p>}

    {route.mode ? <div className={`border ${c.cardStatic} rounded-lg p-6`}>
      <h2 className="text-lg font-medium mb-4">{t(route.mode === "create" ? "audienceStyle.create" : "common.edit")}</h2>
      {route.mode === "edit" && detail.loading ? <p role="status" className="min-h-[400px] text-sm text-muted-foreground">{t("common.loading")}</p> : route.mode === "edit" && detail.error ?
        <div role="alert" className="min-h-[400px] space-y-2 text-sm"><p className="text-destructive">{localizedFailure(detail.error, "audienceStyle.loadFailed")}</p><button onClick={() => void detail.refetch()} className={`px-3 py-1.5 text-sm rounded-md ${c.btnSecondary}`}>{t("common.refresh")}</button></div> :
        <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <fieldset disabled={busy || (route.mode === "create" && initialized)} className="space-y-4 disabled:opacity-60">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <label className={labelClass}>
                {t("audienceStyle.id")}
                <input
                  value={form.id}
                  onChange={(event) => set("id", event.target.value)}
                  disabled={route.mode === "edit"}
                  className={inputClass}
                />
                {route.mode === "edit" && <span className="block mt-1 text-xs text-muted-foreground normal-case tracking-normal">{t("audienceStyle.idHint")}</span>}
              </label>
              <label className={labelClass}>
                {t("audienceStyle.name")}
                <input value={form.name} onChange={(event) => set("name", event.target.value)} className={inputClass} />
              </label>
              <label className={labelClass}>
                {t("audienceStyle.kind")}
                <select
                  value={form.kind}
                  onChange={(event) => set("kind", event.target.value as AudienceStyleTag["kind"])}
                  className={inputClass}
                >
                  <option value="audience">{t("audienceStyle.audience")}</option>
                  <option value="style">{t("audienceStyle.style")}</option>
                </select>
              </label>
              <label className={labelClass}>
                {t("audienceStyle.language")}
                <select
                  value={form.language}
                  onChange={(event) => set("language", event.target.value as "zh" | "en")}
                  className={inputClass}
                >
                  <option value="zh">{t("audienceStyle.zh")}</option>
                  <option value="en">{t("audienceStyle.en")}</option>
                </select>
              </label>
            </div>
            {multilineFields.map((field) => (
              <label key={field} className={labelClass}>
                {t(`audienceStyle.${field}`)}
                <textarea
                  value={form[field] ?? ""}
                  onChange={(event) => set(field, event.target.value)}
                  rows={field === "creativeBrief" ? 6 : 3}
                  className={`${inputClass} ${field === "creativeBrief" ? "font-mono" : ""}`}
                />
                {field === "creativeBrief" && (
                  <span className="text-xs text-muted-foreground normal-case tracking-normal">{t("audienceStyle.briefHint")}</span>
                )}
              </label>
            ))}
            {listFields.map((field) => (
              <label key={field} className={labelClass}>
                {t(`audienceStyle.${field}`)} ({t("genre.commaSeparated")})
                <input
                  type="text"
                  value={form[field]}
                  onChange={(event) => set(field, event.target.value)}
                  className={inputClass}
                />
              </label>
            ))}
            <div className="flex flex-wrap gap-2">
              <button type="submit" className={`px-4 py-2 text-sm rounded-md ${c.btnPrimary}`}>{busy ? t("common.loading") : t("common.save")}</button>
              {!(initialized && route.mode === "create") && <button type="button" disabled={busy} onClick={() => nav.toAudienceStyle(route.mode === "edit" ? form.id : undefined)} className={`px-4 py-2 text-sm rounded-md ${c.btnSecondary}`}>{t("common.cancel")}</button>}
            </div>
          </fieldset>
        </form>}
    </div> : <>
      <label className={labelClass}>
        {t("audienceStyle.filter")}
        <select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)} className={inputClass}>
          {(["all", "audience", "style"] as const).map((value) => <option key={value} value={value}>{t(`audienceStyle.${value}`)}</option>)}
        </select>
      </label>
      <div className="grid grid-cols-1 lg:grid-cols-[250px_minmax(0,1fr)] gap-6" data-testid="audience-style-layout">
        <div className={`min-w-0 border ${c.cardStatic} rounded-lg min-h-[400px] overflow-hidden`} data-testid="audience-style-list">
          {list.loading ? <p role="status" className="px-4 py-3 text-sm text-muted-foreground">{t("common.loading")}</p> : list.error ? (
            <div role="alert" className="px-4 py-3 space-y-2 text-sm">
              <p className="text-destructive">{localizedFailure(list.error, "audienceStyle.loadFailed")}</p>
              <button onClick={() => void list.refetch()} className={`px-3 py-1.5 text-sm rounded-md ${c.btnSecondary}`}>{t("common.refresh")}</button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-4 py-3 space-y-4">
              <p className="text-sm text-muted-foreground">{t(tags.length ? "audienceStyle.noMatches" : "audienceStyle.empty")}</p>
              {!tags.length && (
                <button onClick={() => nav.toAudienceStyle(undefined, "create")} className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md ${c.btnPrimary}`}>
                  <Plus size={16} />{t("audienceStyle.create")}
                </button>
              )}
            </div>
          ) : filtered.map((tag) => (
            <article key={tag.id} aria-label={tag.name}>
              <button
                onClick={() => nav.toAudienceStyle(tag.id)}
                aria-label={tag.name}
                aria-current={route.tagId === tag.id ? "page" : undefined}
                className={`w-full min-w-0 text-left px-4 py-3 border-b border-border/40 transition-colors ${
                  route.tagId === tag.id ? "bg-primary/10 text-primary" : "hover:bg-muted/30"
                }`}
              >
                <div className="text-sm font-medium">{tag.name}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{tag.id} · {tag.language} · {tag.source ?? "project"}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{t(`audienceStyle.${tag.kind}`)}</div>
                {tag.description && <p className="text-sm text-foreground mt-2 whitespace-pre-wrap line-clamp-2">{tag.description}</p>}
              </button>
            </article>
          ))}
        </div>
        <div className={`min-w-0 border ${c.cardStatic} rounded-lg p-6 min-h-[400px]`} data-testid="audience-style-detail">
          {route.tagId ? (
            <div className="space-y-6">
              <button onClick={() => nav.toAudienceStyle()} className={`text-sm ${c.link}`}>{t("audienceStyle.back")}</button>
              {detail.loading ? (
                <p role="status" className="text-sm text-muted-foreground">{t("common.loading")}</p>
              ) : detail.error ? (
                <div role="alert" className="space-y-2 text-sm">
                  <p className="text-destructive">{localizedFailure(detail.error, "audienceStyle.loadFailed")}</p>
                  <button onClick={() => void detail.refetch()} className={`px-3 py-1.5 text-sm rounded-md ${c.btnSecondary}`}>{t("common.refresh")}</button>
                </div>
              ) : selected && <>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0 basis-full xl:basis-0 xl:flex-1">
                    <h2 className="text-xl font-medium">{selected.name}</h2>
                    <p className="text-sm text-muted-foreground mt-1">{selected.id} · {selected.language} · {selected.source ?? "project"} · {t(`audienceStyle.${selected.kind}`)}</p>
                  </div>
                  {actionButtons(selected)}
                </div>
                {multilineFields.map((field) => (
                  <section key={field}>
                    <div role="heading" aria-level={3} className="text-xs text-muted-foreground uppercase tracking-wide mb-2">{t(`audienceStyle.${field}`)}</div>
                    {field === "creativeBrief" && selected[field] ? (
                      <div className="min-w-0 max-h-[300px] overflow-auto text-sm leading-relaxed text-foreground/80 bg-muted/30 p-4 rounded-md">
                        <MessageResponse mode="static">{selected[field]}</MessageResponse>
                      </div>
                    ) : (
                      <p className="text-sm leading-relaxed whitespace-pre-wrap">{selected[field] || t("audienceStyle.noContent")}</p>
                    )}
                  </section>
                ))}
                {listFields.map((field) => (
                  <section key={field}>
                    <div role="heading" aria-level={3} className="text-xs text-muted-foreground uppercase tracking-wide mb-2">{t(`audienceStyle.${field}`)}</div>
                    {selected[field]?.length ? (
                      <ul className="flex flex-wrap gap-2">
                        {selected[field]?.map((value, index) => <li key={index} className="max-w-full px-2 py-1 text-xs bg-secondary rounded">{value}</li>)}
                      </ul>
                    ) : (
                      <p className="text-sm">{t("audienceStyle.noContent")}</p>
                    )}
                  </section>
                ))}
              </>}
            </div>
          ) : (
            <div className="text-muted-foreground text-sm italic flex items-center justify-center min-h-[350px]">
              {t("audienceStyle.selectHint")}
            </div>
          )}
        </div>
      </div>
    </>}
    <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t("audienceStyle.saved")}</DialogTitle></DialogHeader>
        <DialogFooter>
          <button onClick={() => { setSaveDialogOpen(false); nav.toAudienceStyle(); }} className={`px-4 py-2 text-sm rounded-md ${c.btnSecondary}`}>{t("audienceStyle.backHome")}</button>
          <button onClick={() => { setSaveDialogOpen(false); nav.toAudienceStyle(form.id); }} className={`px-4 py-2 text-sm rounded-md ${c.btnPrimary}`}>{t("audienceStyle.viewDetail")}</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <ConfirmDialog open={Boolean(deleteTarget)} title={t("audienceStyle.deleteTitle")} message={t("audienceStyle.deleteConfirm").replace("{name}", deleteTarget?.name ?? "")} confirmLabel={t("common.delete")} cancelLabel={t("common.cancel")} variant="danger" onConfirm={() => { if (!busy) void remove(); }} onCancel={() => { if (!busy) setDeleteTarget(null); }} />
  </div>;
}
