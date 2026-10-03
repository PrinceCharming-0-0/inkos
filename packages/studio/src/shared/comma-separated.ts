export class MixedCommaError extends Error {
  constructor() {
    super("Mixed comma separators");
    this.name = "MixedCommaError";
  }
}

type Comma = "," | "，";

function inputComma(value: string): Comma | undefined {
  if (value.includes(",") && value.includes("，")) throw new MixedCommaError();
  return value.includes(",") ? "," : value.includes("，") ? "，" : undefined;
}

export function parseCommaSeparated(value: string): string[] {
  const comma = inputComma(value);
  return (comma ? value.split(comma) : [value]).map((item) => item.trim()).filter(Boolean);
}

function preferenceKey(projectRoot: string, entity: "genre" | "audience-style", id: string, field: string): string {
  return `inkos:comma-preference:${JSON.stringify([projectRoot, entity, id, field])}`;
}

function savedComma(projectRoot: string, entity: "genre" | "audience-style", id: string, field: string): Comma {
  try {
    const value = window.localStorage.getItem(preferenceKey(projectRoot, entity, id, field));
    return value === "," ? "," : "，";
  } catch {
    // Local storage may be unavailable; use the same default as a new browser.
    return "，";
  }
}

export function formatCommaSeparated(values: ReadonlyArray<string>, projectRoot: string, entity: "genre" | "audience-style", id: string, field: string): string {
  const comma = savedComma(projectRoot, entity, id, field);
  return values.join(comma === "," ? ", " : "，");
}

// Call only after the business data has been saved successfully.
export function rememberCommaSeparated(value: string, projectRoot: string, entity: "genre" | "audience-style", id: string, field: string): void {
  const comma = inputComma(value);
  if (!comma) return; // A single item or empty field does not change a previous preference.
  try {
    window.localStorage.setItem(preferenceKey(projectRoot, entity, id, field), comma);
  } catch {
    // Preference storage must not turn a successful business save into a failure.
  }
}
