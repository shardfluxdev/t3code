import type {
  DesktopSshEnvironmentLink,
  DesktopSshEnvironmentLinkRequest,
} from "@t3tools/contracts";

import { getDesktopScheme } from "../electron/ElectronProtocol.ts";

/** Accepts an alias and an absolute remote directory, never SSH options. */
export function readDesktopSshEnvironmentLink(
  value: string,
  isDevelopment: boolean,
): DesktopSshEnvironmentLink | null {
  if (
    value.length > 8_192 ||
    [...value].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)
  )
    return null;
  try {
    // URLSearchParams replaces malformed escapes and UTF-8; reject them before decoding.
    decodeURIComponent(value);
    const url = new URL(value);
    if (
      url.protocol !== `${getDesktopScheme(isDevelopment)}:` ||
      url.host !== "environments" ||
      url.username ||
      url.password ||
      url.hash ||
      (url.pathname !== "/ssh" && url.pathname !== "/ssh/forget")
    )
      return null;
    const action = url.pathname === "/ssh" ? "open" : "forget";
    const keys = action === "open" ? ["alias", "path"] : ["alias"];
    if ([...url.searchParams.keys()].some((key) => !keys.includes(key))) return null;
    if (keys.some((key) => url.searchParams.getAll(key).length !== 1)) return null;
    const alias = url.searchParams.get("alias")!;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/.test(alias)) return null;
    if (action === "forget") return { action, alias };
    const path = url.searchParams.get("path")!;
    if (
      !path.startsWith("/") ||
      path.length > 4_096 ||
      [...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    )
      return null;
    return { action, alias, path };
  } catch {
    return null;
  }
}

/** Keeps startup links until the real renderer has loaded its connection catalog. */
export class DesktopSshEnvironmentLinkQueue {
  readonly #pending: DesktopSshEnvironmentLinkRequest[] = [];
  #nextId = 0;
  #send: ((request: DesktopSshEnvironmentLinkRequest) => void) | null = null;
  #dispatched = false;

  enqueue(link: DesktopSshEnvironmentLink): void {
    if (
      this.#pending.length >= 16 ||
      this.#pending.some(
        (request) =>
          request.action === link.action &&
          request.alias === link.alias &&
          (request.action === "forget" || (link.action === "open" && request.path === link.path)),
      )
    )
      return;
    this.#pending.push({ ...link, requestId: String(++this.#nextId) });
    this.#flush();
  }

  setRenderer(send: ((request: DesktopSshEnvironmentLinkRequest) => void) | null): void {
    this.#send = send;
    if (send === null) this.#dispatched = false;
    this.#flush();
  }

  complete(requestId: string): void {
    if (this.#pending[0]?.requestId !== requestId) return;
    this.#pending.shift();
    this.#dispatched = false;
    this.#flush();
  }

  #flush(): void {
    const request = this.#pending[0];
    if (!request || !this.#send || this.#dispatched) return;
    this.#dispatched = true;
    this.#send(request);
  }
}
