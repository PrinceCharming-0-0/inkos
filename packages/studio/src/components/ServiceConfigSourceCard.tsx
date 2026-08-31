import { useEffect, useState } from "react";
import { fetchJson } from "../hooks/use-api";
import { tr } from "../lib/app-language";

type ConfigSource = "env" | "studio";
type EnvScope = "project" | "global" | null;

interface EnvConfigSummary {
  detected: boolean;
  provider: string | null;
  baseUrl: string | null;
  model: string | null;
  hasApiKey: boolean;
}

interface SyncChange {
  field: string;
  action: "add" | "update" | "unchanged" | "conflict";
  sourcePresent: boolean;
  targetPresent: boolean;
  sourceValue?: string | number | boolean;
  targetValue?: string | number | boolean;
}

interface SyncResult {
  direction: "env-to-inkos" | "inkos-to-env";
  wrote: boolean;
  changed: boolean;
  conflicts: string[];
  changes: SyncChange[];
  secret: { sourcePresent: boolean; targetPresent: boolean; changed: false };
  warnings?: string[];
}

interface SyncResponse {
  result: SyncResult;
}

interface ServiceConfigPayload {
  services: Array<Record<string, unknown>>;
  defaultModel: string | null;
  configSource: ConfigSource;
  storedConfigSource?: ConfigSource;
  envConfig: {
    project: EnvConfigSummary;
    global: EnvConfigSummary;
    effectiveSource: EnvScope;
    runtimeUsesEnv: boolean;
  };
}

export function ServiceConfigSourceCard({ onChange }: { onChange?: () => void }) {
  const [data, setData] = useState<ServiceConfigPayload | null>(null);
  const [saving, setSaving] = useState<ConfigSource | null>(null);
  const [importing, setImporting] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const payload = await fetchJson<ServiceConfigPayload>("/services/config");
      setData(payload);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : tr("读取配置来源失败", "Failed to load config source"));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const switchSource = async (configSource: ConfigSource) => {
    setSaving(configSource);
    try {
      await fetchJson("/services/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ configSource }),
      });
      await load();
      onChange?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : tr("切换配置来源失败", "Failed to switch config source"));
    } finally {
      setSaving(null);
    }
  };

  const runSync = async (direction: SyncResult["direction"], preview: boolean) => {
    const key = `${direction}:${preview ? "preview" : "write"}`;
    setSyncing(key);
    setError(null);
    try {
      // The sync direction is an explicit user choice: the source side is
      // authoritative and plain value differences are applied as updates.
      const response = await fetchJson<SyncResponse>("/services/config/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction, preview }),
      });
      setSyncResult(response.result);
      if (!preview) {
        await load();
        onChange?.();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : tr("同步配置失败", "Failed to sync config"));
    } finally {
      setSyncing(null);
    }
  };

  const syncBusy = saving !== null || importing || syncing !== null;

  const importEnvConfig = async () => {
    setImporting(true);
    try {
      await fetchJson("/services/config/import-env", {
        method: "POST",
      });
      await load();
      onChange?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : tr("导入环境变量配置失败", "Failed to import env config"));
    } finally {
      setImporting(false);
    }
  };

  if (!data && !error) {
    return (
      <div className="rounded-xl border border-border/40 bg-card/70 p-4 text-sm text-muted-foreground/70">
        {tr("正在读取配置来源…", "Loading config source…")}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.04] p-4 text-sm text-amber-600">
        {error ?? tr("读取配置来源失败", "Failed to load config source")}
      </div>
    );
  }

  const { configSource, envConfig } = data;
  const storedConfigSource = data.storedConfigSource ?? configSource;
  const activeEnvSummary = envConfig.effectiveSource === "project" ? envConfig.project : envConfig.global;
  const envLabel = envConfig.effectiveSource === "project"
    ? tr("项目 .env", "Project .env")
    : envConfig.effectiveSource === "global"
      ? tr("全局 ~/.inkos/.env", "Global ~/.inkos/.env")
      : null;
  const envDetected = envConfig.project.detected || envConfig.global.detected;

  return (
    <div className="rounded-xl border border-border/40 bg-card/70 p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium">{tr("LLM 配置来源", "LLM config source")}</div>
          <div className="text-xs text-muted-foreground/70 mt-1">
            {tr("Studio 运行时：", "Studio runtime:")}
            <span className="text-foreground"> {tr("使用服务页配置和 Studio 密钥", "uses service page config and Studio keys")}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void switchSource("studio")}
            disabled={syncBusy || configSource === "studio"}
            className="rounded-lg border border-border/50 px-3 py-1.5 text-xs hover:bg-secondary/50 disabled:opacity-50"
          >
            {saving === "studio" ? tr("切换中…", "Switching…") : tr("使用 Studio 配置", "Use Studio config")}
          </button>
          <button
            type="button"
            onClick={() => void runSync("env-to-inkos", true)}
              disabled={syncBusy}
              className="rounded-lg border border-border/50 px-3 py-1.5 text-xs hover:bg-secondary/50 disabled:opacity-50"
            >
              {syncing === "env-to-inkos:preview" ? tr("预览中…", "Previewing…") : tr("预览导入到 Studio", "Preview import to Studio")}
            </button>
            <button
              type="button"
              onClick={() => void runSync("env-to-inkos", false)}
              disabled={syncBusy}
              className="rounded-lg border border-border/50 bg-secondary/40 px-3 py-1.5 text-xs hover:bg-secondary/70 disabled:opacity-50"
            >
              {syncing === "env-to-inkos:write" ? tr("应用中…", "Applying…") : tr("应用到 Studio", "Apply to Studio")}
            </button>
            <button
              type="button"
              onClick={() => void runSync("inkos-to-env", true)}
              disabled={syncBusy}
              className="rounded-lg border border-border/50 px-3 py-1.5 text-xs hover:bg-secondary/50 disabled:opacity-50"
            >
              {syncing === "inkos-to-env:preview" ? tr("预览中…", "Previewing…") : tr("预览导出到 .env", "Preview export to .env")}
            </button>
            <button
              type="button"
              onClick={() => void runSync("inkos-to-env", false)}
              disabled={syncBusy}
              className="rounded-lg border border-border/50 bg-secondary/40 px-3 py-1.5 text-xs hover:bg-secondary/70 disabled:opacity-50"
            >
              {syncing === "inkos-to-env:write" ? tr("导出中…", "Exporting…") : tr("导出到 .env", "Export to .env")}
            </button>
          </div>
          {envDetected && activeEnvSummary.hasApiKey ? (
            <button
              type="button"
              onClick={() => void importEnvConfig()}
              disabled={syncBusy}
              className="rounded-lg border border-border/50 bg-secondary/40 px-3 py-1.5 text-xs hover:bg-secondary/70 disabled:opacity-50"
            >
              {importing ? tr("导入中…", "Importing…") : tr("导入并保存密钥", "Import and save key")}
            </button>
          ) : null}
      </div>

      {storedConfigSource === "env" ? (
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/[0.04] p-3 text-xs text-muted-foreground/80">
          {tr(
            "检测到旧配置标记为 `.env` 优先。Studio 运行时不会使用它；CLI、daemon 和部署环境仍可按 env 覆盖层使用。",
            "A legacy setting marks `.env` as preferred. The Studio runtime ignores it; CLI, daemon, and deployment environments may still use the env override layer.",
          )}
        </div>
      ) : null}

      {envDetected ? (
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/[0.04] p-3 text-xs text-muted-foreground/80 space-y-1.5">
          <div className="text-foreground">
            {tr("检测到 LLM 环境变量覆盖：", "Detected LLM environment variable override:")}
            <span className="font-medium"> {envLabel ?? tr("已检测到但未定位来源", "detected but source not located")}</span>
          </div>
          {activeEnvSummary.baseUrl ? <div>Base URL: <span className="font-mono text-foreground">{activeEnvSummary.baseUrl}</span></div> : null}
          {activeEnvSummary.model ? <div>Model: <span className="font-mono text-foreground">{activeEnvSummary.model}</span></div> : null}
          {activeEnvSummary.provider ? <div>Provider: <span className="font-mono text-foreground">{activeEnvSummary.provider}</span></div> : null}
          <div>API Key: <span className="text-foreground">{activeEnvSummary.hasApiKey ? tr("已设置", "set") : tr("未设置", "not set")}</span></div>
          <div className="text-muted-foreground/70 pt-1">
            {tr(
              "当前虽然检测到 .env，但 Studio 和 Agent 请求不会直接使用这套覆盖；点击“导入检测到的配置”后，会把它保存为 Studio 服务配置。",
              "A .env override was detected, but Studio and agent requests do not use it directly. Click “Import detected config” to save it as Studio service config.",
            )}
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-border/30 bg-secondary/20 p-3 text-xs text-muted-foreground/75">
          {tr(
            "未检测到目录或全局 `.env` 里的 LLM 覆盖变量。当前会直接使用项目配置和 Studio 服务配置。",
            "No LLM override variables detected in the project or global `.env`. Project config and Studio service config are used directly.",
          )}
        </div>
      )}

      {syncResult ? (
        <div className="rounded-lg border border-border/30 bg-secondary/20 p-3 text-xs text-muted-foreground/80 space-y-1.5">
          <div className="text-foreground">
            {syncResult.wrote
              ? (syncResult.direction === "env-to-inkos"
                ? tr("已应用到 Studio", "Applied to Studio")
                : tr("已导出到 .env", "Exported to .env"))
              : syncResult.changed
                ? tr("预览：以下字段将从源侧应用到目标侧", "Preview: the following fields will be applied from source to target")
                : tr("配置已一致，无需写入", "Configuration is already in sync; nothing was written")}
          </div>
          {(() => {
            const meaningful = syncResult.changes.filter((change) => change.action !== "unchanged");
            if (meaningful.length === 0) return null;
            const sideNames = syncResult.direction === "env-to-inkos"
              ? { source: tr(".env", ".env"), target: tr("Studio", "Studio") }
              : { source: tr("Studio", "Studio"), target: tr(".env", ".env") };
            return (
              <div className="space-y-1">
                <div>{syncResult.wrote ? tr("已更新字段：", "Updated fields:") : tr("将更新字段：", "Fields to update:")}</div>
                <ul className="list-inside list-disc space-y-0.5">
                  {meaningful.map((change) => (
                    <li key={change.field}>
                      <span className="font-mono text-foreground">{change.field}</span>
                      {change.action === "add" ? (
                        <span> {tr("新增", "add")}: <span className="font-mono text-foreground">{String(change.sourceValue)}</span></span>
                      ) : (
                        <span>
                          {tr("：", ": ")}
                          <span className="font-mono line-through text-muted-foreground/60">{change.targetValue === undefined ? tr("（无）", "(none)") : String(change.targetValue)}</span>
                          <span> {tr("→", "→")} </span>
                          <span className="font-mono text-foreground">{change.sourceValue === undefined ? tr("（无）", "(none)") : String(change.sourceValue)}</span>
                        </span>
                      )}
                      <span className="text-muted-foreground/50"> ({sideNames.source} → {sideNames.target})</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })()}
          {(syncResult.warnings ?? []).length > 0 ? (
            <div className="text-amber-600 space-y-1">
              {(syncResult.warnings ?? []).map((warning, index) => (
                <div key={index}>{warning}</div>
              ))}
            </div>
          ) : null}
          <div>
            {tr("API Key 不会被导入或导出；两侧密钥状态保持不变：", "API keys are never imported or exported; key status on both sides is unchanged:")}
            <div className="pl-2">
              <div>
                {syncResult.direction === "env-to-inkos" ? tr(".env 侧：", ".env side:") : tr("Studio 侧：", "Studio side:")}
                <span className="text-foreground"> {syncResult.secret.sourcePresent ? tr("已设置", "set") : tr("未设置", "not set")}</span>
              </div>
              <div>
                {syncResult.direction === "env-to-inkos" ? tr("Studio 侧（应用后）：", "Studio side (after apply):") : tr(".env 侧（导出后）：", ".env side (after export):")}
                <span className="text-foreground"> {syncResult.secret.targetPresent ? tr("已设置", "set") : tr("未设置", "not set")}</span>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="text-xs text-rose-500">{error}</div>
      ) : null}
    </div>
  );
}
