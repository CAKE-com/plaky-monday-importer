const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

export function hostnameOf(host: string): string {
  const bracketed = /^\[([^\]]*)\](?::\d+)?$/.exec(host);
  return (bracketed ? bracketed[1]! : host.replace(/:\d+$/, "")).toLowerCase();
}

export function refuseRequest(headers: Pick<Headers, "get">): string | null {
  const host = headers.get("host") ?? "";
  const hostname = hostnameOf(host);
  if (!LOOPBACK.has(hostname) && !hostname.endsWith(".localhost")) return `refused: host ${hostname || "(none)"} is not a loopback address`;
  const site = headers.get("sec-fetch-site")?.toLowerCase() ?? null;
  if (site !== null && site !== "same-origin" && site !== "none") return `refused: ${site === "cross-site" || site === "same-site" ? site : "unknown fetch site"} request`;
  if (headers.get("sec-fetch-mode")?.toLowerCase() === "no-cors") return "refused: no-cors request";
  const origin = headers.get("origin");
  if (origin !== null && origin !== "null") {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return "refused: unreadable origin";
    }
    if (originHost.toLowerCase() !== host.toLowerCase()) return "refused: cross-origin request";
  } else if (origin === "null") return "refused: opaque origin";
  return null;
}
