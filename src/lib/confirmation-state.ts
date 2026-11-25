type ConfirmationState = "unavailable" | "working" | "awaiting_name" | "confirmed";
export function confirmationState(name: string | null, typed: string, working: boolean, blocked = false): ConfirmationState {
  if (working) return "working";
  if (name === null || blocked) return "unavailable";
  return typed.trim() === name.trim() ? "confirmed" : "awaiting_name";
}
