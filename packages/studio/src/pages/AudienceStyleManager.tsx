import { useEffect, useState } from "react";
import { Plus, Pencil, Trash2 } from "lucide-react";
import type { AudienceStyleTag } from "@actalk/inkos-core";
import { fetchJson, postApi, putApi, useApi } from "../hooks/use-api";
import type { Theme } from "../hooks/use-theme";
import type { StringKey, TFunction } from "../hooks/use-i18n";
import { audienceStyleStrings } from "../shared/audience-style-strings";
import { useColors } from "../hooks/use-colors";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { MessageResponse } from "../components/ai-elements/message";

const API = "/audience-style-tags";
const inputClass = "mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm disabled:opacity-50";
const multilineFields = ["description", "readerExperience", "narrativeStyle", "creativeBrief"] as const;
const listFields = ["relationshipAndElements", "avoidElements"] as const;
type Mode = "create" | "edit";
interface Nav {
  toDashboard: () => void;
  toAudienceStyle: (tagId?: string, mode?: Mode) => void;
}

function emptyTag(language: "zh" | "en"): AudienceStyleTag {
  return {
    id: "", name: "", kind: "audience", language,
    description: "", readerExperience: "", narrativeStyle: "",
    relationshipAndElements: [], avoidElements: [], creativeBrief: "",
  };
}

export function AudienceStyleManager({ route, nav, theme, t, language }: {
  route: { tagId?: string; mode?: Mode };
  nav: Nav;
  theme: Theme;
  t: TFunction;
  language: "zh" | "en";
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
  const [form, setForm] = useState<AudienceStyleTag>(() => emptyTag(language));
  const [initialized, setInitialized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AudienceStyleTag | null>(null);
  useEffect(() => {
    if (route.mode === "edit" && detail.data && !detail.loading && !detail.error && !initialized) {
      setForm(detail.data.tag);
      setInitialized(true);
    }
  }, [route.mode, detail.data, detail.loading, detail.error, initialized]);

  const set = <K extends keyof AudienceStyleTag>(key: K, value: AudienceStyleTag[K]) => setForm((current) => ({ ...current, [key]: value }));
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
        relationshipAndElements: (form.relationshipAndElements ?? []).map((value) => value.trim()).filter(Boolean),
        avoidElements: (form.avoidElements ?? []).map((value) => value.trim()).filter(Boolean),
      };
      if (route.mode === "edit") await putApi(`${API}/${encodeURIComponent(route.tagId!)}`, payload);
      else await postApi(`${API}/create`, payload);
      // Stay in the form to make successful persistence explicit and disable the saved id.
      setForm(payload);
      setNotice(t("audienceStyle.saved"));
      if (route.mode === "create") setInitialized(true);
      await list.refetch();
      if (route.mode === "edit") await detail.refetch();
    } catch (error) {
      setFailure(localizedFailure(error, "audienceStyle.saveFailed"));
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
    <div className="flex gap-2 flex-wrap">
      <button
        disabled={busy}
        onClick={() => nav.toAudienceStyle(tag.id, "edit")}
        className={`flex items-center gap-1 px-3 py-1.5 text-sm rounded-md ${c.btnSecondary}`}
      >
        <Pencil size={14} />{t("common.edit")}
      </button>
      <button
        disabled={busy}
        onClick={() => setDeleteTarget(tag)}
        className={`flex items-center gap-1 px-3 py-1.5 text-sm rounded-md ${c.btnDanger}`}
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

  return <div className="space-y-6">
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <button onClick={nav.toDashboard} className={c.link}>{t("bread.home")}</button><span>/</span>
      <button onClick={() => nav.toAudienceStyle()} className={c.link}>{t("audienceStyle.title")}</button>
    </div>
    <div className="flex items-center justify-between gap-3">
      <h1 className="font-serif text-3xl">{t("audienceStyle.title")}</h1>
      {!route.mode && <button onClick={() => nav.toAudienceStyle(undefined, "create")} className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md ${c.btnPrimary}`}><Plus size={16} />{t("audienceStyle.create")}</button>}
    </div>
    {notice && <p role="status" className="text-sm text-primary">{notice}</p>}
    {failure && <p role="alert" className="text-sm text-destructive">{failure}</p>}

    {route.mode ? <div className={`border ${c.cardStatic} rounded-lg p-6`}>
      <h2 className="text-lg font-medium mb-4">{t(route.mode === "create" ? "audienceStyle.create" : "common.edit")}</h2>
      {route.mode === "edit" && detail.loading ? <p>{t("common.loading")}</p> : route.mode === "edit" && detail.error ?
        <div role="alert"><p>{localizedFailure(detail.error, "audienceStyle.loadFailed")}</p><button onClick={() => void detail.refetch()}>{t("common.refresh")}</button></div> :
        <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <fieldset disabled={busy || (route.mode === "create" && initialized)} className="space-y-4 disabled:opacity-60">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <label className="text-sm">
                {t("audienceStyle.id")}
                <input
                  value={form.id}
                  onChange={(event) => set("id", event.target.value)}
                  disabled={route.mode === "edit"}
                  className={inputClass}
                />
                <span className="block mt-1 text-xs text-muted-foreground">{t("audienceStyle.idHint")}</span>
              </label>
              <label className="text-sm">
                {t("audienceStyle.name")}
                <input value={form.name} onChange={(event) => set("name", event.target.value)} className={inputClass} />
              </label>
              <label className="text-sm">
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
              <label className="text-sm">
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
              <label key={field} className="block text-sm">
                {t(`audienceStyle.${field}`)}
                <textarea
                  value={form[field] ?? ""}
                  onChange={(event) => set(field, event.target.value)}
                  rows={field === "creativeBrief" ? 6 : 3}
                  className={`${inputClass} ${field === "creativeBrief" ? "font-mono" : ""}`}
                />
                {field === "creativeBrief" && (
                  <span className="text-xs text-muted-foreground">{t("audienceStyle.briefHint")}</span>
                )}
              </label>
            ))}
            {listFields.map((field) => (
              <fieldset key={field} className="space-y-2">
                <legend className="text-sm mb-2">{t(`audienceStyle.${field}`)}</legend>
                {(form[field] ?? []).map((value, index) => (
                  <div key={index} className="flex gap-2 items-center">
                    <input
                      aria-label={`${t(`audienceStyle.${field}`)} ${index + 1}`}
                      value={value}
                      onChange={(event) => set(field, (form[field] ?? []).map((item, itemIndex) =>
                        itemIndex === index ? event.target.value : item))}
                      className={inputClass}
                    />
                    <button
                      type="button"
                      aria-label={`${t("audienceStyle.removeItem")} ${t(`audienceStyle.${field}`)} ${index + 1}`}
                      onClick={() => set(field, (form[field] ?? []).filter((_, itemIndex) => itemIndex !== index))}
                      className={`p-2 rounded-md ${c.btnDanger}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => set(field, [...(form[field] ?? []), ""])}
                  className={`px-3 py-1.5 text-sm rounded-md ${c.btnSecondary}`}
                >
                  {t("audienceStyle.addItem")}
                </button>
              </fieldset>
            ))}
            <button type="submit" className={`px-4 py-2 text-sm rounded-md ${c.btnPrimary}`}>{busy ? t("common.loading") : t("common.save")}</button>
          </fieldset>
          <button type="button" disabled={busy} onClick={() => nav.toAudienceStyle(route.mode === "edit" || initialized ? form.id : undefined)} className={`px-4 py-2 text-sm rounded-md ${c.btnSecondary}`}>{initialized && route.mode === "create" ? t("audienceStyle.viewDetail") : t("common.cancel")}</button>
        </form>}
    </div> : route.tagId ? <div className={`border ${c.cardStatic} rounded-lg p-6 space-y-6`}>
      <button onClick={() => nav.toAudienceStyle()} className={c.link}>{t("audienceStyle.back")}</button>
      {detail.loading ? <p>{t("common.loading")}</p> : detail.error ? <div role="alert"><p>{localizedFailure(detail.error, "audienceStyle.loadFailed")}</p><button onClick={() => void detail.refetch()}>{t("common.refresh")}</button></div> : selected && <>
        <div className="space-y-3"><h2 className="text-xl font-medium">{selected.name}</h2><p className="text-sm text-muted-foreground">{selected.id} · {t(`audienceStyle.${selected.kind}`)} · {selected.language}</p>{actionButtons(selected)}</div>
        {multilineFields.map((field) => (
          <section key={field}>
            <h3 className="text-sm font-medium mb-2">{t(`audienceStyle.${field}`)}</h3>
            {field === "creativeBrief" && selected[field] ? (
              <MessageResponse mode="static">{selected[field]}</MessageResponse>
            ) : (
              <p className="text-sm whitespace-pre-wrap">{selected[field] || t("audienceStyle.noContent")}</p>
            )}
          </section>
        ))}
        {listFields.map((field) => (
          <section key={field}>
            <h3 className="text-sm font-medium mb-2">{t(`audienceStyle.${field}`)}</h3>
            {selected[field]?.length ? (
              <ul className="list-disc pl-5 text-sm space-y-1">
                {selected[field]?.map((value, index) => <li key={index}>{value}</li>)}
              </ul>
            ) : (
              <p className="text-sm">{t("audienceStyle.noContent")}</p>
            )}
          </section>
        ))}
      </>}
    </div> : <>
      <label className="block max-w-xs text-sm">{t("audienceStyle.filter")}<select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)} className={inputClass}>{(["all", "audience", "style"] as const).map((value) => <option key={value} value={value}>{t(`audienceStyle.${value}`)}</option>)}</select></label>
      {list.loading ? <p>{t("common.loading")}</p> : list.error ? <div role="alert" className="space-y-2"><p>{localizedFailure(list.error, "audienceStyle.loadFailed")}</p><button onClick={() => void list.refetch()} className={`px-3 py-1.5 rounded-md ${c.btnSecondary}`}>{t("common.refresh")}</button></div> : filtered.length === 0 ?
        <div className={`border ${c.cardStatic} rounded-lg p-8 text-center space-y-4`}><p>{t(tags.length ? "audienceStyle.noMatches" : "audienceStyle.empty")}</p><button onClick={() => nav.toAudienceStyle(undefined, "create")} className={`px-3 py-1.5 rounded-md ${c.btnPrimary}`}>{t("audienceStyle.create")}</button></div> :
        <div className="space-y-3">
          {filtered.map((tag) => (
            <article key={tag.id} aria-label={tag.name} className={`border ${c.cardStatic} rounded-lg p-4 space-y-3`}>
              <button onClick={() => nav.toAudienceStyle(tag.id)} className={`font-medium ${c.link}`}>
                {tag.name}
              </button>
              <p className="text-xs text-muted-foreground">{t(`audienceStyle.${tag.kind}`)} · {tag.language}</p>
              {tag.description && <p className="text-sm whitespace-pre-wrap line-clamp-2">{tag.description}</p>}
              {actionButtons(tag)}
            </article>
          ))}
        </div>}
    </>}
    <ConfirmDialog open={Boolean(deleteTarget)} title={t("audienceStyle.deleteTitle")} message={t("audienceStyle.deleteConfirm").replace("{name}", deleteTarget?.name ?? "")} confirmLabel={t("common.delete")} cancelLabel={t("common.cancel")} variant="danger" onConfirm={() => { if (!busy) void remove(); }} onCancel={() => { if (!busy) setDeleteTarget(null); }} />
  </div>;
}
