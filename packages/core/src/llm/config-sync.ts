import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "dotenv";
import { commitAtomicFileSet } from "../utils/atomic-file-set.js";
import {
  guessServiceFromBaseUrl,
  resolveServicePreset,
  resolveServiceProviderFamily,
} from "./service-presets.js";

export type LLMConfigSyncDirection = "env-to-inkos" | "inkos-to-env";
export type LLMConfigSyncConflictPolicy = "error" | "source" | "target";

export interface LLMConfigSyncOptions {
  readonly direction: LLMConfigSyncDirection;
  readonly conflictPolicy?: LLMConfigSyncConflictPolicy;
  readonly write?: boolean;
}

export interface LLMConfigSyncChange {
  readonly field: string;
  readonly action: "add" | "update" | "unchanged" | "conflict";
  readonly sourcePresent: boolean;
  readonly targetPresent: boolean;
}

export interface LLMConfigSyncResult {
  readonly direction: LLMConfigSyncDirection;
  readonly wrote: boolean;
  readonly changed: boolean;
  readonly conflicts: readonly string[];
  readonly changes: readonly LLMConfigSyncChange[];
  readonly secret: {
    readonly sourcePresent: boolean;
    readonly targetPresent: boolean;
    readonly changed: false;
  };
}

interface SyncValues {
  service?: string;
  provider?: "anthropic" | "openai" | "custom";
  baseUrl?: string;
  model?: string;
  apiFormat?: "chat" | "responses" | "anthropic";
  stream?: boolean;
  temperature?: number;
  thinkingBudget?: number;
  proxyUrl?: string;
  extra: Record<string, string | number | boolean>;
}

interface ParsedEnvFile {
  readonly raw: string;
  readonly values: Record<string, string>;
}

const ENV_KEYS = {
  service: "INKOS_LLM_SERVICE",
  provider: "INKOS_LLM_PROVIDER",
  baseUrl: "INKOS_LLM_BASE_URL",
  model: "INKOS_LLM_MODEL",
  apiFormat: "INKOS_LLM_API_FORMAT",
  stream: "INKOS_LLM_STREAM",
  temperature: "INKOS_LLM_TEMPERATURE",
  thinkingBudget: "INKOS_LLM_THINKING_BUDGET",
  proxyUrl: "INKOS_LLM_PROXY_URL",
} as const;

const SYNC_FIELDS = [
  "service",
  "provider",
  "baseUrl",
  "model",
  "apiFormat",
  "stream",
  "temperature",
  "thinkingBudget",
  "proxyUrl",
] as const;

export async function syncLLMConfig(
  projectRoot: string,
  options: LLMConfigSyncOptions,
): Promise<LLMConfigSyncResult> {
  const conflictPolicy = options.conflictPolicy ?? "error";
  const env = await readEnvFile(join(projectRoot, ".env"));
  const config = await readConfig(projectRoot);
  const source = options.direction === "env-to-inkos"
    ? valuesFromEnv(env.values)
    : valuesFromConfig(config);
  const target = options.direction === "env-to-inkos"
    ? valuesFromConfig(config)
    : valuesFromEnv(env.values);
  const secretPresence = await readSecretPresence(projectRoot, env.values, config, source.service ?? target.service);
  if (!hasSyncValues(source)) {
    return buildResult(options.direction, [], [], secretPresence, false, false);
  }
  const changes = compareValues(source, target, conflictPolicy);
  const conflicts = changes.filter((change) => change.action === "conflict").map((change) => change.field);

  if (changes.every((change) => change.action === "unchanged")) {
    return buildResult(options.direction, changes, [], secretPresence, false, false);
  }

  if (conflicts.length > 0 && conflictPolicy === "error") {
    return buildResult(options.direction, changes, conflicts, secretPresence, false, false);
  }

  const shouldWrite = options.write ?? true;
  if (!shouldWrite) {
    return buildResult(options.direction, changes, conflicts, secretPresence, false, false);
  }

  if (options.direction === "env-to-inkos") {
    const nextConfig = applyValuesToConfig(config, source, target, conflictPolicy);
    const content = JSON.stringify(nextConfig, null, 2) + "\n";
    const currentContent = await readFile(join(projectRoot, "inkos.json"), "utf-8");
    if (content !== currentContent) {
      await commitAtomicFileSet({
        rootDir: projectRoot,
        writes: [{ relativePath: "inkos.json", content }],
      });
    }
    return buildResult(options.direction, changes, conflicts, secretPresence, content !== currentContent, true);
  }

  const nextEnv = applyValuesToEnv(env.raw, source, target, conflictPolicy);
  if (nextEnv !== env.raw) {
    await commitAtomicFileSet({
      rootDir: projectRoot,
      writes: [{ relativePath: ".env", content: nextEnv }],
    });
  }
  return buildResult(options.direction, changes, conflicts, secretPresence, nextEnv !== env.raw, true);
}

async function readConfig(projectRoot: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(projectRoot, "inkos.json"), "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("inkos.json must contain a JSON object");
  }
  return parsed as Record<string, unknown>;
}

async function readEnvFile(path: string): Promise<ParsedEnvFile> {
  let raw = "";
  try {
    raw = await readFile(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { raw, values: parse(raw) };
}

function valuesFromEnv(values: Record<string, string>): SyncValues {
  const baseUrl = stringValue(values[ENV_KEYS.baseUrl]);
  const service = stringValue(values[ENV_KEYS.service])
    ?? (baseUrl ? guessServiceFromBaseUrl(baseUrl) : undefined);
  const providerValue = stringValue(values[ENV_KEYS.provider]);
  const provider = providerValue
    ? parseProvider(providerValue)
    : service
      ? resolveServiceProviderFamily(service)
      : undefined;

  return {
    service,
    provider,
    baseUrl,
    model: stringValue(values[ENV_KEYS.model]),
    apiFormat: parseApiFormat(values[ENV_KEYS.apiFormat])
      ?? apiFormatFromPreset(service ? resolveServicePreset(service)?.api : undefined),
    stream: parseBooleanValue(values[ENV_KEYS.stream]),
    temperature: parseNumberValue(values[ENV_KEYS.temperature], "INKOS_LLM_TEMPERATURE"),
    thinkingBudget: parseIntegerValue(values[ENV_KEYS.thinkingBudget], "INKOS_LLM_THINKING_BUDGET"),
    proxyUrl: stringValue(values[ENV_KEYS.proxyUrl]),
    extra: readExtraValues(values),
  };
}

function valuesFromConfig(config: Record<string, unknown>): SyncValues {
  const llm = recordValue(config.llm);
  const services = serviceEntries(llm.services);
  const configuredService = stringValue(llm.service)
    ?? (services.length === 1 ? serviceEntryKey(services[0]!) : undefined);
  const selected = services.find((entry) => serviceEntryKey(entry) === configuredService)
    ?? services[0];
  const service = configuredService
    ?? (stringValue(llm.baseUrl) ? guessServiceFromBaseUrl(stringValue(llm.baseUrl)!) : undefined)
    ?? (stringValue(llm.provider) ? "custom" : undefined);
  const preset = service ? resolveServicePreset(service) : undefined;
  const provider = parseProvider(stringValue(llm.provider))
    ?? (service ? resolveServiceProviderFamily(service) : undefined);
  const baseUrl = stringValue(selected?.baseUrl)
    ?? stringValue(llm.baseUrl)
    ?? (preset?.baseUrl || undefined);
  const apiFormat = parseApiFormat(selected?.apiFormat)
    ?? parseApiFormat(llm.apiFormat)
    ?? apiFormatFromPreset(preset?.api);
  const stream = booleanValue(selected?.stream) ?? booleanValue(llm.stream);

  return {
    service,
    provider,
    baseUrl,
    model: stringValue(llm.defaultModel) ?? stringValue(llm.model) ?? firstModel(selected?.models),
    apiFormat,
    stream,
    temperature: numberValue(selected?.temperature) ?? numberValue(llm.temperature),
    thinkingBudget: numberValue(llm.thinkingBudget),
    proxyUrl: stringValue(llm.proxyUrl),
    extra: recordToScalarMap(llm.extra),
  };
}

function compareValues(
  source: SyncValues,
  target: SyncValues,
  conflictPolicy: LLMConfigSyncConflictPolicy,
): LLMConfigSyncChange[] {
  const changes: LLMConfigSyncChange[] = [];
  for (const field of SYNC_FIELDS) {
    const sourceValue = source[field];
    const targetValue = target[field];
    const sourcePresent = sourceValue !== undefined;
    const targetPresent = targetValue !== undefined;
    changes.push({
      field,
      action: classifyChange(sourceValue, targetValue, conflictPolicy),
      sourcePresent,
      targetPresent,
    });
  }

  const extraKeys = new Set([...Object.keys(source.extra), ...Object.keys(target.extra)]);
  for (const key of extraKeys) {
    const sourceValue = source.extra[key];
    const targetValue = target.extra[key];
    changes.push({
      field: `extra.${key}`,
      action: classifyChange(sourceValue, targetValue, conflictPolicy),
      sourcePresent: sourceValue !== undefined,
      targetPresent: targetValue !== undefined,
    });
  }
  return changes;
}

function classifyChange(
  sourceValue: unknown,
  targetValue: unknown,
  conflictPolicy: LLMConfigSyncConflictPolicy,
): LLMConfigSyncChange["action"] {
  if (sourceValue === undefined) return "unchanged";
  if (targetValue === undefined) return "add";
  if (sameValue(sourceValue, targetValue)) return "unchanged";
  return conflictPolicy === "error" ? "conflict" : conflictPolicy === "source" ? "update" : "unchanged";
}

function applyValuesToConfig(
  config: Record<string, unknown>,
  source: SyncValues,
  target: SyncValues,
  conflictPolicy: LLMConfigSyncConflictPolicy,
): Record<string, unknown> {
  const next = cloneRecord(config);
  const llm = recordValue(next.llm);
  next.llm = llm;
  const selectedService = source.service ?? target.service ?? "custom";
  const existingServices = serviceEntries(llm.services);
  const hasExistingServices = existingServices.length > 0;
  const existingEntry = existingServices.find((entry) => serviceEntryKey(entry) === selectedService);
  const entry: Record<string, unknown> = existingEntry ? { ...existingEntry } : {
    service: selectedService === "custom" || selectedService.startsWith("custom:") ? "custom" : selectedService,
  };
  if (selectedService.startsWith("custom:") && !entry.name) {
    entry.name = selectedService.slice("custom:".length) || "Custom";
  }
  if (selectedService === "custom" && !entry.name) entry.name = "Env LLM";

  const value = (field: keyof SyncValues): SyncValues[typeof field] => {
    const sourceValue = source[field];
    if (sourceValue === undefined) return undefined;
    if (conflictPolicy === "target" && target[field] !== undefined && !sameValue(sourceValue, target[field])) {
      return undefined;
    }
    return sourceValue;
  };
  const service = value("service");
  const provider = value("provider");
  const baseUrl = value("baseUrl");
  const model = value("model");
  const apiFormat = value("apiFormat");
  const stream = value("stream");
  const temperature = value("temperature");
  const thinkingBudget = value("thinkingBudget");
  const proxyUrl = value("proxyUrl");

  if (service !== undefined) llm.service = service;
  if (provider !== undefined) llm.provider = provider;
  if (baseUrl !== undefined) {
    if (!hasExistingServices) llm.baseUrl = baseUrl;
    const preset = resolveServicePreset(selectedService);
    if (hasExistingServices && selectedService !== "custom" && preset?.baseUrl === baseUrl) delete entry.baseUrl;
    else entry.baseUrl = baseUrl;
  }
  if (model !== undefined) {
    llm.defaultModel = model;
    if (!hasExistingServices) llm.model = model;
  }
  if (apiFormat !== undefined) {
    if (!hasExistingServices) llm.apiFormat = apiFormat;
    entry.apiFormat = apiFormat;
  }
  if (stream !== undefined) {
    if (!hasExistingServices) llm.stream = stream;
    entry.stream = stream;
  }
  if (temperature !== undefined) {
    if (!hasExistingServices) llm.temperature = temperature;
    entry.temperature = temperature;
  }
  if (thinkingBudget !== undefined) llm.thinkingBudget = thinkingBudget;
  if (proxyUrl !== undefined) llm.proxyUrl = proxyUrl;

  const extra = { ...recordValue(llm.extra) };
  for (const [key, sourceValue] of Object.entries(source.extra)) {
    if (sourceValue === undefined) continue;
    if (conflictPolicy === "target" && target.extra[key] !== undefined && !sameValue(sourceValue, target.extra[key])) continue;
    extra[key] = sourceValue;
  }
  if (Object.keys(extra).length > 0) llm.extra = extra;

  const nextServices = existingServices.filter((item) => serviceEntryKey(item) !== selectedService);
  nextServices.push(entry);
  llm.services = nextServices;
  llm.configSource = "studio";
  return next;
}

function applyValuesToEnv(
  raw: string,
  source: SyncValues,
  target: SyncValues,
  conflictPolicy: LLMConfigSyncConflictPolicy,
): string {
  const values: Record<string, string> = {};
  const set = (key: string, field: keyof SyncValues, format: (value: NonNullable<SyncValues[typeof field]>) => string = String) => {
    const sourceValue = source[field];
    const selected = sourceValue !== undefined
      && !(conflictPolicy === "target" && target[field] !== undefined && !sameValue(sourceValue, target[field]))
      ? sourceValue
      : undefined;
    if (selected !== undefined) values[key] = format(selected as NonNullable<SyncValues[typeof field]>);
  };

  set(ENV_KEYS.service, "service");
  set(ENV_KEYS.provider, "provider");
  set(ENV_KEYS.baseUrl, "baseUrl");
  set(ENV_KEYS.model, "model");
  set(ENV_KEYS.apiFormat, "apiFormat");
  set(ENV_KEYS.stream, "stream", (value) => value ? "true" : "false");
  set(ENV_KEYS.temperature, "temperature");
  set(ENV_KEYS.thinkingBudget, "thinkingBudget");
  set(ENV_KEYS.proxyUrl, "proxyUrl");
  for (const [key, value] of Object.entries(source.extra)) {
    if (conflictPolicy === "target" && target.extra[key] !== undefined && !sameValue(value, target.extra[key])) continue;
    values[`INKOS_LLM_EXTRA_${key}`] = String(value);
  }
  return patchEnvText(raw, values);
}

function patchEnvText(raw: string, updates: Record<string, string>): string {
  const newline = raw.includes("\r\n") ? "\r\n" : "\n";
  const hasFinalNewline = raw.endsWith("\n");
  const lines = raw.split(/\r?\n/);
  if (hasFinalNewline) lines.pop();
  const seen = new Set<string>();
  const nextLines = lines.map((line) => {
    const match = line.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=)(.*)$/);
    if (!match || !(match[2] in updates)) return line;
    const key = match[2]!;
    seen.add(key);
    return `${match[1]}${key}${match[3]}${formatEnvValue(updates[key]!)}`;
  });

  const missing = Object.entries(updates).filter(([key]) => !seen.has(key));
  if (missing.length > 0) {
    if (nextLines.length > 0 && nextLines[nextLines.length - 1] !== "") nextLines.push("");
    nextLines.push(...missing.map(([key, value]) => `${key}=${formatEnvValue(value)}`));
  }
  return nextLines.join(newline) + (hasFinalNewline || nextLines.length > 0 ? newline : "");
}

function buildResult(
  direction: LLMConfigSyncDirection,
  changes: readonly LLMConfigSyncChange[],
  conflicts: readonly string[],
  secretPresence: { readonly env: boolean; readonly inkos: boolean },
  changed: boolean,
  wrote: boolean,
): LLMConfigSyncResult {
  return {
    direction,
    wrote,
    changed,
    conflicts,
    changes,
    secret: {
      sourcePresent: direction === "env-to-inkos" ? secretPresence.env : secretPresence.inkos,
      targetPresent: direction === "env-to-inkos" ? secretPresence.inkos : secretPresence.env,
      changed: false,
    },
  };
}

async function readSecretPresence(
  projectRoot: string,
  envValues: Record<string, string>,
  config: Record<string, unknown>,
  service: string | undefined,
): Promise<{ readonly env: boolean; readonly inkos: boolean }> {
  let inkos = Boolean(stringValue(recordValue(config.llm).apiKey));
  if (service) {
    try {
      const raw = await readFile(join(projectRoot, ".inkos", "secrets.json"), "utf-8");
      const parsed = recordValue(JSON.parse(raw));
      const services = recordValue(parsed.services);
      inkos = inkos || Boolean(stringValue(recordValue(services[service]).apiKey));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return { env: Boolean(stringValue(envValues["INKOS_LLM_API_KEY"])), inkos };
}

function hasSyncValues(values: SyncValues): boolean {
  return SYNC_FIELDS.some((field) => values[field] !== undefined) || Object.keys(values.extra).length > 0;
}

function serviceEntries(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry));
}

function serviceEntryKey(entry: Record<string, unknown>): string {
  return entry.service === "custom" ? `custom:${stringValue(entry.name) ?? "Custom"}` : stringValue(entry.service) ?? "custom";
}

function firstModel(value: unknown): string | undefined {
  return Array.isArray(value) ? stringValue(value[0]) : undefined;
}

function apiFormatFromPreset(api: string | undefined): SyncValues["apiFormat"] {
  if (api === "anthropic-messages") return "anthropic";
  if (api === "openai-responses") return "responses";
  if (api === "openai-completions") return "chat";
  return undefined;
}

function parseProvider(value: unknown): SyncValues["provider"] {
  const normalized = stringValue(value);
  if (!normalized) return undefined;
  if (normalized === "anthropic" || normalized === "openai" || normalized === "custom") return normalized;
  throw new Error(`Unsupported INKOS_LLM_PROVIDER value: ${normalized}`);
}

function parseApiFormat(value: unknown): SyncValues["apiFormat"] {
  const normalized = stringValue(value);
  if (!normalized) return undefined;
  if (normalized === "chat" || normalized === "responses" || normalized === "anthropic") return normalized;
  throw new Error(`Unsupported INKOS_LLM_API_FORMAT value: ${normalized}`);
}

function parseBooleanValue(value: unknown): boolean | undefined {
  const normalized = stringValue(value)?.toLowerCase();
  if (!normalized) return undefined;
  if (["true", "1", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${normalized}`);
}

function parseNumberValue(value: unknown, key: string): number | undefined {
  const normalized = stringValue(value);
  if (!normalized) return undefined;
  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric value for ${key}`);
  return parsed;
}

function parseIntegerValue(value: unknown, key: string): number | undefined {
  const normalized = stringValue(value);
  if (!normalized) return undefined;
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isInteger(parsed)) throw new Error(`Invalid integer value for ${key}`);
  return parsed;
}

function readExtraValues(values: Record<string, string>): Record<string, string | number | boolean> {
  const extra: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!key.startsWith("INKOS_LLM_EXTRA_") || !value.trim()) continue;
    extra[key.slice("INKOS_LLM_EXTRA_".length)] = parseScalar(value);
  }
  return extra;
}

function recordToScalarMap(value: unknown): Record<string, string | number | boolean> {
  const record = recordValue(value);
  const result: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") result[key] = item;
  }
  return result;
}

function parseScalar(value: string): string | number | boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  const number = Number(value);
  return Number.isFinite(number) && value.trim() !== "" ? number : value;
}

function formatEnvValue(value: string): string {
  return /^[A-Za-z0-9_./:@+\-]+$/.test(value) ? value : JSON.stringify(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function sameValue(left: unknown, right: unknown): boolean {
  return left === right;
}
