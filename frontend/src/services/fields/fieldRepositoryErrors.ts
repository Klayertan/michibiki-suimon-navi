// Repository-layer errors, translated into operator-facing messages at the UI
// boundary rather than surfacing a raw stack trace (docs/UI_REDESIGN.md
// Stage 2 section / task section 21). `warnings`/`detail` are kept for
// developer logging only.

export class FieldValidationError extends Error {
  readonly warnings: string[]

  constructor(message: string, warnings: string[] = []) {
    super(message)
    this.name = 'FieldValidationError'
    this.warnings = warnings
  }
}

export class FieldNotFoundError extends Error {
  readonly fieldId: string

  constructor(fieldId: string) {
    super(`Field "${fieldId}" was not found.`)
    this.name = 'FieldNotFoundError'
    this.fieldId = fieldId
  }
}

export class FieldSaveError extends Error {
  readonly detail: unknown

  constructor(message: string, detail?: unknown) {
    super(message)
    this.name = 'FieldSaveError'
    this.detail = detail
  }
}
