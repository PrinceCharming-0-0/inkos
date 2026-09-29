import { fetchJson } from "../hooks/use-api";
import type { ApiFormat } from "@actalk/inkos-core";

export interface ServiceDetailModelInfo {
  readonly id: string;
  readonly name?: string;
}

export function mergeServiceDetailModels(
  ...groups: ReadonlyArray<ReadonlyArray<ServiceDetailModelInfo | string> | undefined>
): ServiceDetailModelInfo[] {
  const seen = new Set<string>();
  const merged: ServiceDetailModelInfo[] = [];
  for (const group of groups) {
    for (const item of group ?? []) {
      const model = typeof item === "string" ? { id: item } : item;
      const id = model.id.trim();
      const key = id.toLowerCase();
      if (!id || seen.has(key)) continue;
      seen.add(key);
      merged.push({ ...model, id });
    }
  }
  return merged;
}

function sameModelId(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Configured models are the user's saved list; discovered models (probe results,
 * live store catalogs) are only offered for adding and are never shown as configured.
 */
export function deriveServiceDetailModelView(
  configuredModels: ReadonlyArray<ServiceDetailModelInfo>,
  ...discoveredGroups: ReadonlyArray<ReadonlyArray<ServiceDetailModelInfo | string> | undefined>
): { configured: ServiceDetailModelInfo[]; discovered: ServiceDetailModelInfo[] } {
  const configured = mergeServiceDetailModels(configuredModels);
  const discovered = mergeServiceDetailModels(...discoveredGroups)
    .filter((model) => !configured.some((item) => sameModelId(item.id, model.id)));
  return { configured, discovered };
}

export function removeServiceDetailModel(
  configuredModels: ReadonlyArray<ServiceDetailModelInfo>,
  modelId: string,
): ServiceDetailModelInfo[] {
  return configuredModels.filter((model) => !sameModelId(model.id, modelId));
}

/** Discovery seeds the configured list once; after that the user's list is authoritative. */
export function applyDiscoveredServiceDetailModels(args: {
  readonly configuredModels: ReadonlyArray<ServiceDetailModelInfo>;
  readonly hasConfiguredModelList: boolean;
  readonly discoveredModels: ReadonlyArray<ServiceDetailModelInfo>;
}): { configuredModels: ServiceDetailModelInfo[]; hasConfiguredModelList: boolean } {
  if (args.hasConfiguredModelList) {
    return { configuredModels: [...args.configuredModels], hasConfiguredModelList: true };
  }
  return {
    configuredModels: mergeServiceDetailModels(args.configuredModels, args.discoveredModels),
    hasConfiguredModelList: true,
  };
}

export interface ServiceDetailIdentity {
  readonly isCustom: boolean;
  /** Trimmed name currently typed into the form (custom services only). */
  readonly customName: string;
  /** Identity stored before this edit; null for a custom service that does not exist yet. */
  readonly persistedServiceId: string | null;
  /** Identity the edit will be saved under. */
  readonly effectiveServiceId: string;
  /** Present only when the edit renames an existing custom service. */
  readonly previousServiceId?: string;
}

export function resolveServiceDetailIdentity(routeServiceId: string, customNameInput: string): ServiceDetailIdentity {
  const isCustom = routeServiceId === "custom" || routeServiceId.startsWith("custom:");
  if (!isCustom) {
    return { isCustom, customName: "", persistedServiceId: routeServiceId, effectiveServiceId: routeServiceId };
  }
  const customName = customNameInput.trim();
  const persistedServiceId = routeServiceId.startsWith("custom:") ? routeServiceId : null;
  const effectiveServiceId = customName ? `custom:${customName}` : (persistedServiceId ?? "custom");
  return {
    isCustom,
    customName,
    persistedServiceId,
    effectiveServiceId,
    ...(persistedServiceId && persistedServiceId !== effectiveServiceId ? { previousServiceId: persistedServiceId } : {}),
  };
}

function resolveSavedDefaultModel(
  candidates: ReadonlyArray<string | undefined>,
  savedModels: ReadonlyArray<ServiceDetailModelInfo>,
  hasConfiguredModelList: boolean,
): string {
  for (const candidate of candidates) {
    if (!candidate?.trim()) continue;
    if (savedModels.length === 0 && !hasConfiguredModelList) return candidate;
    const match = savedModels.find((model) => sameModelId(model.id, candidate));
    if (match) return match.id;
  }
  return savedModels[0]?.id ?? "";
}

export interface ServiceDetailDetectedConfig {
  readonly apiFormat?: ApiFormat;
  readonly stream?: boolean;
  readonly baseUrl?: string;
  readonly modelsSource?: "api" | "fallback";
}

export type ServiceDetailConnectionStatus =
  | { state: "idle" }
  | { state: "testing" }
  | { state: "connected"; models: ServiceDetailModelInfo[] }
  | { state: "error"; message: string }
  | { state: "saving" }
  | { state: "saved" };

type JsonFetcher = typeof fetchJson;

export interface ServiceProbeResponse {
  readonly ok: boolean;
  readonly models?: ServiceDetailModelInfo[];
  readonly selectedModel?: string;
  readonly detected?: ServiceDetailDetectedConfig;
  readonly error?: string;
}

export interface ServiceDetailVerifiedProbe {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly apiFormat: ApiFormat;
  readonly stream: boolean;
  readonly models: ServiceDetailModelInfo[];
  readonly selectedModel?: string;
  readonly detected?: ServiceDetailDetectedConfig;
}

export async function probeServiceForDetail(
  serviceId: string,
  body: {
    readonly apiKey: string;
    readonly apiFormat: ApiFormat;
    readonly stream: boolean;
    readonly baseUrl?: string;
  },
  deps?: { readonly fetchJsonImpl?: JsonFetcher },
): Promise<ServiceProbeResponse> {
  const fetchJsonImpl = deps?.fetchJsonImpl ?? fetchJson;
  return await fetchJsonImpl<ServiceProbeResponse>(
    `/services/${encodeURIComponent(serviceId)}/test`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

export async function rehydrateServiceConnectionStatus(args: {
  readonly effectiveServiceId: string;
  readonly shouldVerify: boolean;
  readonly isCustom: boolean;
  readonly baseUrl: string;
  readonly apiFormat: ApiFormat;
  readonly stream: boolean;
  readonly fetchJsonImpl?: JsonFetcher;
}): Promise<{
  readonly apiKey: string;
  readonly status: ServiceDetailConnectionStatus;
  readonly detectedModel: string;
  readonly detectedConfig: ServiceDetailDetectedConfig | null;
}> {
  const fetchJsonImpl = args.fetchJsonImpl ?? fetchJson;
  const secret = await fetchJsonImpl<{ apiKey?: string }>(
    `/services/${encodeURIComponent(args.effectiveServiceId)}/secret`,
  );
  const apiKey = String(secret.apiKey ?? "");

  return {
    apiKey,
    status: { state: "idle" },
    detectedModel: "",
    detectedConfig: null,
  };
}

export function matchServiceConfigEntryForDetail(
  entries: ReadonlyArray<Record<string, unknown>>,
  serviceId: string,
): Record<string, unknown> | undefined {
  return entries.find((entry) => {
    if (typeof entry.service !== "string") return false;
    if (serviceId.startsWith("custom:")) {
      return entry.service === "custom" && `custom:${String(entry.name ?? "")}` === serviceId;
    }
    if (serviceId === "custom") return false;
    return entry.service === serviceId;
  });
}

export async function saveServiceConfig(args: {
  readonly effectiveServiceId: string;
  /** Route id: the persisted identity (`custom` alone means a new custom service). */
  readonly serviceId: string;
  readonly isCustom: boolean;
  readonly apiKeyOptional?: boolean;
  readonly resolvedCustomName: string;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly apiFormat: ApiFormat;
  readonly stream: boolean;
  readonly temperature: string;
  readonly detectedModel: string;
  /** The user's explicit list; when present it replaces, and is never merged with, probe results. */
  readonly configuredModels?: ReadonlyArray<ServiceDetailModelInfo | string>;
  readonly verifiedProbe?: ServiceDetailVerifiedProbe | null;
  readonly fetchJsonImpl?: JsonFetcher;
}): Promise<{
  readonly status: ServiceDetailConnectionStatus;
  readonly detectedModel: string;
  readonly detectedConfig: ServiceDetailDetectedConfig | null;
}> {
  const fetchJsonImpl = args.fetchJsonImpl ?? fetchJson;
  const trimmedKey = args.apiKey.trim();
  const trimmedBaseUrl = args.baseUrl.trim();

  if (!trimmedKey && !args.isCustom && !args.apiKeyOptional) {
    return {
      status: { state: "error", message: "请先输入 API Key" },
      detectedModel: "",
      detectedConfig: null,
    };
  }
  if (args.isCustom && !trimmedBaseUrl) {
    return {
      status: { state: "error", message: "请先填写 Base URL" },
      detectedModel: "",
      detectedConfig: null,
    };
  }
  if (args.isCustom && !args.resolvedCustomName.trim()) {
    return {
      status: { state: "error", message: "请先填写服务名称" },
      detectedModel: "",
      detectedConfig: null,
    };
  }

  const persistedServiceId = args.isCustom
    ? (args.serviceId.startsWith("custom:") ? args.serviceId : null)
    : args.serviceId;
  const previousService = persistedServiceId && persistedServiceId !== args.effectiveServiceId
    ? persistedServiceId
    : undefined;
  const isCreate = args.isCustom && !persistedServiceId;

  const verifiedBaseUrl = args.isCustom ? trimmedBaseUrl : "";
  const verified = args.verifiedProbe;
  const canReuseVerifiedProbe = Boolean(
    verified
      && verified.apiKey === trimmedKey
      && verified.baseUrl === verifiedBaseUrl
      && verified.apiFormat === args.apiFormat
      && verified.stream === args.stream,
  );

  let probe: ServiceProbeResponse;
  if (canReuseVerifiedProbe && verified) {
    probe = {
      ok: true,
      models: verified.models,
      selectedModel: verified.selectedModel,
      detected: verified.detected,
    };
  } else {
    try {
      probe = await probeServiceForDetail(args.effectiveServiceId, {
        apiKey: trimmedKey,
        apiFormat: args.apiFormat,
        stream: args.stream,
        ...(args.isCustom ? { baseUrl: trimmedBaseUrl } : {}),
      }, { fetchJsonImpl });
    } catch (error) {
      return {
        status: { state: "error", message: error instanceof Error ? error.message : "连接失败" },
        detectedModel: "",
        detectedConfig: null,
      };
    }
  }

  if (!probe.ok) {
    return {
      status: { state: "error", message: probe.error ?? "连接失败" },
      detectedModel: "",
      detectedConfig: null,
    };
  }

  const hasConfiguredModelList = args.configuredModels !== undefined;
  const savedModels = hasConfiguredModelList
    ? mergeServiceDetailModels(args.configuredModels)
    : mergeServiceDetailModels(probe.models);
  const detectedModel = resolveSavedDefaultModel(
    [probe.selectedModel, args.detectedModel],
    savedModels,
    hasConfiguredModelList,
  );
  const detectedConfig = probe.detected ?? null;
  const savedApiFormat = detectedConfig?.apiFormat ?? args.apiFormat;
  const savedStream = typeof detectedConfig?.stream === "boolean" ? detectedConfig.stream : args.stream;
  const savedBaseUrl = args.isCustom ? (detectedConfig?.baseUrl ?? trimmedBaseUrl) : undefined;

  const saveSecret = async () => {
    await fetchJsonImpl(`/services/${encodeURIComponent(args.effectiveServiceId)}/secret`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: trimmedKey }),
    });
  };
  // Create/rename can be rejected (duplicate name), so the config goes first and the
  // secret is only written once the server has accepted the new identity.
  const identityChanges = isCreate || Boolean(previousService);
  if (!identityChanges) await saveSecret();

  try {
    await fetchJsonImpl("/services/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service: args.effectiveServiceId,
        ...(previousService ? { previousService } : {}),
        ...(isCreate ? { intent: "create" } : {}),
        ...(detectedModel ? { defaultModel: detectedModel } : {}),
        services: [
          {
            service: args.isCustom ? "custom" : args.serviceId,
            temperature: parseFloat(args.temperature),
            apiFormat: savedApiFormat,
            stream: savedStream,
            models: savedModels.map((model) => model.id),
            ...(args.isCustom ? {
              name: args.resolvedCustomName.trim(),
              baseUrl: savedBaseUrl,
            } : {}),
          },
        ],
      }),
    });
  } catch (error) {
    return {
      status: { state: "error", message: error instanceof Error ? error.message : "保存失败" },
      detectedModel: "",
      detectedConfig: null,
    };
  }
  if (identityChanges) await saveSecret();

  return {
    status: { state: "connected", models: savedModels },
    detectedModel,
    detectedConfig,
  };
}

export async function deleteServiceConfig(
  serviceId: string,
  deps?: { readonly fetchJsonImpl?: JsonFetcher },
): Promise<void> {
  const fetchJsonImpl = deps?.fetchJsonImpl ?? fetchJson;
  await fetchJsonImpl(`/services/${encodeURIComponent(serviceId)}`, {
    method: "DELETE",
  });
}
