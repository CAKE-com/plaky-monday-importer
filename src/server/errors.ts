export class ConflictError extends Error {
  override name = "ConflictError";
}

export class PreconditionError extends Error {
  override name = "PreconditionError";
}
