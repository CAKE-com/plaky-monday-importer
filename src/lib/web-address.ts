export const PLAKY_WEB_ADDRESS = /^https:\/\/[a-z0-9][a-z0-9-]*\.plaky\.com$/;
export const PLAKY_WEB_ADDRESS_HINT = "a Plaky workspace address looks like https://yourcompany.plaky.com";
export const normalizeWebAddress = (value: string): string => value.trim().replace(/\/+$/, "").toLowerCase();

export function workspaceName(address: string | null | undefined): string | null {
  if (!address) return null;
  try {
    return new URL(address).hostname.split(".")[0] || null;
  } catch {
    return null;
  }
}
