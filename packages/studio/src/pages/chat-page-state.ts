export interface ChatPageModelInfo {
  readonly id: string;
  readonly name?: string;
}

export interface ChatPageModelGroup {
  readonly serviceId: string;
  readonly serviceName: string;
  readonly models: ReadonlyArray<ChatPageModelInfo>;
}

export interface ChatPageModelPreference {
  readonly model?: string | null;
  readonly service?: string | null;
}

/** One entry of the persisted service config (`GET /services/config` → `services`). */
export interface ChatPageConfiguredServiceEntry {
  readonly service: string;
  readonly name?: string | null;
  readonly models?: ReadonlyArray<string> | null;
}

export interface ChatPageServiceInfo {
  readonly service: string;
  readonly label: string;
  readonly connected?: boolean;
}

/** Same identity rule as the server's serviceConfigKey: custom entries are keyed by name. */
export function chatServiceConfigKey(entry: {
  readonly service: string;
  readonly name?: string | null;
}): string {
  return entry.service === "custom" ? `custom:${entry.name ?? "Custom"}` : entry.service;
}

/**
 * Authoritative chat picker options: every eligible connected service's
 * persisted configured model list. Live/discovered catalogs are never an
 * input. Each group keeps its canonical service identity so duplicate model
 * ids remain distinct pairs.
 */
export function buildConfiguredModelGroups(args: {
  readonly services: ReadonlyArray<ChatPageServiceInfo>;
  readonly configuredServices: ReadonlyArray<ChatPageConfiguredServiceEntry>;
}): ChatPageModelGroup[] {
  const configuredByKey = new Map<string, ChatPageConfiguredServiceEntry>();
  for (const entry of args.configuredServices) {
    configuredByKey.set(chatServiceConfigKey(entry), entry);
  }

  return args.services.flatMap((service) => {
    if (service.connected === false) return [];
    const entry = configuredByKey.get(service.service);
    if (!entry) return [];

    const seen = new Set<string>();
    const models: ChatPageModelInfo[] = [];
    for (const raw of entry.models ?? []) {
      const id = typeof raw === "string" ? raw.trim() : "";
      const key = id.toLowerCase();
      if (!id || seen.has(key)) continue;
      seen.add(key);
      models.push({ id, name: id });
    }
    if (models.length === 0) return [];
    return [{ serviceId: service.service, serviceName: service.label, models }];
  });
}

export type ChatSelectionSync =
  | { readonly kind: "noop" }
  | { readonly kind: "set"; readonly model: string | null; readonly service: string | null };

/**
 * Idempotent selection synchronization for the ChatPage effect.
 *
 * Invariant: when the store already holds a valid {service, model} pair, the
 * result is a no-op — zero state writes. Writes are emitted only when the
 * primitive pair (serviceId, modelId) actually changes, so replaying this
 * transition always terminates regardless of how often the effect re-runs.
 */
export function resolveSelectionSync(
  groupedModels: ReadonlyArray<ChatPageModelGroup>,
  selectedModel: string | null,
  selectedService: string | null,
  preference?: ChatPageModelPreference | null,
): ChatSelectionSync {
  const currentValid = Boolean(
    selectedModel
    && selectedService
    && groupedModels.some((group) =>
      group.serviceId === selectedService
      && group.models.some((model) => model.id === selectedModel),
    ),
  );
  if (currentValid) return { kind: "noop" };

  const nextSelection = pickModelSelection(groupedModels, selectedModel, selectedService, preference);
  const nextModel = nextSelection?.model ?? null;
  const nextService = nextSelection?.service ?? null;
  if (nextModel === selectedModel && nextService === selectedService) return { kind: "noop" };
  return { kind: "set", model: nextModel, service: nextService };
}

export interface ChatPageSessionSummary {
  readonly sessionId: string;
  readonly sessionKind?: string;
  readonly messageCount: number;
}

const BOOK_CREATE_SESSION_KEY = "inkos.book-create.session-id";
const PROJECT_CHAT_SESSION_KEY = "inkos.project-chat.session-id";

export function getBookCreateSessionId(): string | null {
  return globalThis.localStorage?.getItem(BOOK_CREATE_SESSION_KEY) ?? null;
}

export function setBookCreateSessionId(sessionId: string): void {
  globalThis.localStorage?.setItem(BOOK_CREATE_SESSION_KEY, sessionId);
}

export function clearBookCreateSessionId(): void {
  globalThis.localStorage?.removeItem(BOOK_CREATE_SESSION_KEY);
}

export function getProjectChatSessionId(): string | null {
  return globalThis.localStorage?.getItem(PROJECT_CHAT_SESSION_KEY) ?? null;
}

export function setProjectChatSessionId(sessionId: string): void {
  globalThis.localStorage?.setItem(PROJECT_CHAT_SESSION_KEY, sessionId);
}

export function filterModelGroups(
  groupedModels: ReadonlyArray<ChatPageModelGroup>,
  search: string,
): ReadonlyArray<ChatPageModelGroup> {
  const query = search.trim().toLowerCase();
  if (!query) return groupedModels;

  return groupedModels
    .map((group) => ({
      ...group,
      models: group.models.filter((model) =>
        (model.name ?? model.id).toLowerCase().includes(query)
        || group.serviceName.toLowerCase().includes(query),
      ),
    }))
    .filter((group) => group.models.length > 0);
}

export function pickModelSelection(
  groupedModels: ReadonlyArray<ChatPageModelGroup>,
  selectedModel: string | null,
  selectedService: string | null,
  preference?: ChatPageModelPreference | null,
): { model: string; service: string } | null {
  const selectedStillAvailable = selectedModel && selectedService
    ? groupedModels.some((group) =>
        group.serviceId === selectedService
        && group.models.some((model) => model.id === selectedModel),
      )
    : false;
  if (selectedStillAvailable) return null;

  const preferredService = preference?.service?.trim();
  const preferredModel = preference?.model?.trim();
  if (preferredService) {
    const preferredGroup = groupedModels.find((group) => group.serviceId === preferredService);
    const exactModel = preferredModel
      ? preferredGroup?.models.find((model) => model.id === preferredModel)
      : undefined;
    if (preferredGroup && exactModel) {
      return { model: exactModel.id, service: preferredGroup.serviceId };
    }
    const firstPreferredModel = preferredGroup?.models[0];
    if (preferredGroup && firstPreferredModel) {
      return { model: firstPreferredModel.id, service: preferredGroup.serviceId };
    }
  }

  if (selectedService) {
    const selectedGroup = groupedModels.find((group) => group.serviceId === selectedService);
    const firstSelectedModel = selectedGroup?.models[0];
    if (selectedGroup && firstSelectedModel) {
      return { model: firstSelectedModel.id, service: selectedGroup.serviceId };
    }
    return null;
  }

  const firstGroup = groupedModels.find((group) => group.models.length > 0);
  const firstModel = firstGroup?.models[0];
  if (!firstGroup || !firstModel) return null;
  return { model: firstModel.id, service: firstGroup.serviceId };
}

export function pickProjectChatSessionId(
  sessions: ReadonlyArray<ChatPageSessionSummary>,
): string | null {
  const projectSurfaceSessions = sessions.filter((session) =>
    !session.sessionKind
    || session.sessionKind === "chat"
    || session.sessionKind === "short"
    || session.sessionKind === "play"
    || session.sessionKind === "script"
    || session.sessionKind === "storyboard"
    || session.sessionKind === "interactive-film"
  );
  return projectSurfaceSessions.find((session) => session.messageCount > 0)?.sessionId
    ?? projectSurfaceSessions[0]?.sessionId
    ?? null;
}

export function shouldShowPlayChoicePanel(input: {
  readonly playMode?: string | null;
  readonly choiceSetKey?: string | null;
  readonly consumedChoiceKey?: string | null;
  readonly choiceCount: number;
}): boolean {
  if (input.playMode !== "guided") return false;
  if (!input.choiceSetKey) return false;
  if (input.choiceCount <= 0) return false;
  return input.choiceSetKey !== input.consumedChoiceKey;
}

export function isChatScrollNearBottom(input: {
  readonly scrollTop: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
  readonly thresholdPx?: number;
}): boolean {
  const threshold = input.thresholdPx ?? 96;
  const distanceFromBottom = input.scrollHeight - input.scrollTop - input.clientHeight;
  return distanceFromBottom <= threshold;
}

export function getChatScrollBehavior(isStreaming: boolean): "auto" | "smooth" {
  return isStreaming ? "auto" : "smooth";
}
