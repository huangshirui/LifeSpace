export type ModelFieldValidationDetails = {
  // Client-controlled or current-authorized Model Contract field only.
  fieldPath: string;
  reasonCode: "FIELD_REQUIRED" | "FIELD_UNKNOWN" | "FIELD_UNAVAILABLE"
    | "FIELD_READ_ONLY" | "FIELD_IMMUTABLE" | "FIELD_INVALID_ENUM"
    | "FIELD_INVALID_VALUE";
  repair: string;
};

// Only canonical Model input validation may attach these diagnostics.
// Never use this structure for a failed permission/record-existence check.
export function modelFieldValidationDetails(
  fieldKey: string,
  reasonCode: ModelFieldValidationDetails["reasonCode"],
): ModelFieldValidationDetails | undefined {
  if (!/^[a-z][A-Za-z0-9]{0,62}$/u.test(fieldKey)) return undefined;
  const repair = {
    FIELD_REQUIRED: "Supply this required field using the current authorized Model Contract.",
    FIELD_UNKNOWN: "Remove this field or use a field declared by the current authorized Model Contract.",
    FIELD_UNAVAILABLE: "Use a currently writable field; do not infer whether the requested field exists.",
    FIELD_READ_ONLY: "Remove this read-only field from the write payload.",
    FIELD_IMMUTABLE: "Do not change this immutable field after creation.",
    FIELD_INVALID_ENUM: "Use an allowed value from the current authorized Model Contract.",
    FIELD_INVALID_VALUE: "Check the field type and constraints in the current authorized Model Contract.",
  }[reasonCode];
  return { fieldPath: "data." + fieldKey, reasonCode, repair };
}

export function success<T>(data: T): { data: T } {
  return { data };
}

export function failure(code: string, message: string, requestId: string, details?: ModelFieldValidationDetails) {
  return { error: { code, message, requestId, ...(details ? { details } : {}) } };
}

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: 400 | 401 | 403 | 404 | 405 | 409 | 413 | 415 | 422 | 429 | 500 | 502 | 503 | 504,
    public details?: ModelFieldValidationDetails,
  ) {
    super(message);
  }
}
