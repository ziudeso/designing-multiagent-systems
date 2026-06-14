/**
 * Schema utilities for type handling and coercion in workflow components.
 *
 * Ported from Python `schema_utils.py`. Adapted to TS/JSON notions: JSON schema
 * type strings ("string", "integer", "number", "boolean", "object", "array")
 * are mapped to JS runtime kinds rather than Python classes.
 */

/** JSON Schema fragment for a single field. */
export interface JsonSchemaField {
  type?: string;
  anyOf?: JsonSchemaField[];
  items?: JsonSchemaField;
  additionalProperties?: JsonSchemaField | boolean;
  default?: unknown;
  [key: string]: unknown;
}

/** A full (object) JSON schema with properties/required. */
export interface JsonSchema extends JsonSchemaField {
  properties?: Record<string, JsonSchemaField>;
  required?: string[];
}

/**
 * Extract the primary (non-null) type from a JSON schema field definition.
 *
 * Handles both direct `type` schemas and `anyOf` schemas (common for optional
 * types like `Optional[int]`). Falls back to "string".
 */
export function extractPrimaryTypeFromSchema(fieldSchema: JsonSchemaField): string {
  if (fieldSchema.type) {
    return fieldSchema.type;
  }

  if (Array.isArray(fieldSchema.anyOf)) {
    for (const option of fieldSchema.anyOf) {
      if (option && typeof option === "object" && option.type && option.type !== "null") {
        return option.type;
      }
    }
  }

  return "string";
}

/**
 * Coerce a value to match the expected type based on a JSON schema.
 *
 * Provides defensive type conversion to handle cases where values don't match
 * the expected schema types (e.g. after serialization/deserialization). If
 * coercion is not needed or not possible, the original value is returned.
 */
export function coerceValueToSchemaType(
  value: unknown,
  fieldName: string,
  modelSchema: JsonSchema
): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  const properties = modelSchema.properties ?? {};
  const fieldSchema = properties[fieldName];
  if (!fieldSchema) {
    return value;
  }

  const targetType = extractPrimaryTypeFromSchema(fieldSchema);

  try {
    if (targetType === "integer") {
      if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
        return parseInt(value, 10);
      }
      if (typeof value === "number") {
        return Math.trunc(value);
      }
    } else if (targetType === "number") {
      if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {
        return Number(value);
      }
      if (typeof value === "number") {
        return value;
      }
    } else if (targetType === "string") {
      if (typeof value !== "string") {
        return String(value);
      }
    } else if (targetType === "boolean") {
      if (typeof value === "boolean") {
        return value;
      }
      if (typeof value === "string") {
        return ["true", "1", "yes", "on"].includes(value.toLowerCase());
      }
      if (typeof value === "number") {
        return Boolean(value);
      }
    } else if (targetType === "object") {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value;
      }
    } else if (targetType === "array") {
      if (Array.isArray(value)) {
        return value;
      }
    }
  } catch {
    // If coercion fails, return original value.
  }

  return value;
}

/** A loose runtime descriptor for a JSON schema type, the TS analogue of a Python type. */
export type RuntimeTypeKind = "string" | "number" | "boolean" | "array" | "object";

/**
 * Map a JSON schema type string to a runtime type kind.
 *
 * Python returns a `Type` (e.g. `str`, `int`); TS has no first-class runtime
 * class for primitives in the same way, so we return a descriptive kind string.
 * `integer` and `number` both map to "number" (JS has a single number type).
 */
export function getTypeFromJsonSchemaType(jsonType: string): RuntimeTypeKind {
  const typeMap: Record<string, RuntimeTypeKind> = {
    string: "string",
    integer: "number",
    number: "number",
    boolean: "boolean",
    array: "array",
    object: "object"
  };
  return typeMap[jsonType] ?? "string";
}
