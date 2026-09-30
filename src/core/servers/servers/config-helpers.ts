import type { ServerDefinition } from "../../modeling/types.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function expectOptionalTransport(
  definition: ServerDefinition,
  serverName: string,
  expected: "stdio" | "http",
): void {
  const transport = definition.transport;
  if (transport === undefined) {
    return;
  }

  if (transport !== expected) {
    throw new Error(`Server "${serverName}" transport must be "${expected}".`);
  }
}

export function expectNonEmptyString(
  definition: ServerDefinition,
  fieldName: string,
  serverName: string,
): string {
  const value = definition[fieldName];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Server "${serverName}" must provide a non-empty ${fieldName}.`);
  }
  return value;
}

export function expectOptionalString(
  definition: ServerDefinition,
  fieldName: string,
  serverName: string,
): string | undefined {
  const value = definition[fieldName];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Server "${serverName}" field "${fieldName}" must be a string.`);
  }
  return value;
}

export function expectOptionalStringArray(
  definition: ServerDefinition,
  fieldName: string,
  serverName: string,
): string[] | undefined {
  const value = definition[fieldName];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
    throw new Error(`Server "${serverName}" field "${fieldName}" must be an array of strings.`);
  }
  return [...value];
}

export function expectOptionalStringRecord(
  definition: ServerDefinition,
  fieldName: string,
  serverName: string,
): Record<string, string> | undefined {
  const value = definition[fieldName];
  if (value === undefined) {
    return undefined;
  }
  if (!isObject(value) || Object.values(value).some(item => typeof item !== "string")) {
    throw new Error(`Server "${serverName}" field "${fieldName}" must be an object of string values.`);
  }
  return { ...value } as Record<string, string>;
}
