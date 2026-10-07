import { connectionRoutes, type ConnectionCatalogEntry } from "@t3tools/client-runtime/connection";
import type {
  DesktopSshEnvironmentLink,
  DesktopSshEnvironmentTarget,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

export interface SavedSshEnvironment {
  readonly environmentId: EnvironmentId;
  readonly target: DesktopSshEnvironmentTarget;
}

export interface DesktopSshEnvironmentReadiness {
  readonly ready: boolean;
  readonly error: string | null;
}

/** Waits on the existing connection/snapshot state, including terminal rejections. */
export function waitForDesktopSshEnvironment(input: {
  readonly read: () => DesktopSshEnvironmentReadiness;
  readonly subscribe: (listener: () => void) => () => void;
  readonly signal: AbortSignal;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      input.signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(new Error("The SSH environment link was cancelled."));
    const check = () => {
      if (input.signal.aborted) {
        abort();
        return;
      }
      const state = input.read();
      if (state.error !== null) finish(new Error(state.error));
      else if (state.ready) finish(null);
    };
    check();
    if (settled) return;
    input.signal.addEventListener("abort", abort, { once: true });
    unsubscribe = input.subscribe(check);
    // Subscription can synchronously deliver; also close the initial read/subscribe gap.
    if (settled) unsubscribe();
    else check();
  });
}

export function findSavedSshEnvironment(
  entries: ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>,
  alias: string,
): SavedSshEnvironment | null {
  const matches: SavedSshEnvironment[] = [];
  for (const [environmentId, entry] of entries) {
    for (const route of connectionRoutes(entry)) {
      const profile = Option.getOrNull(route.profile);
      if (
        route.target._tag === "SshConnectionTarget" &&
        profile?._tag === "SshConnectionProfile" &&
        profile.target.alias === alias
      ) {
        matches.push({ environmentId, target: profile.target });
        break;
      }
    }
  }
  if (matches.length > 1)
    throw new Error(
      `More than one saved environment uses SSH alias ${alias}. Manage them in Connections.`,
    );
  return matches[0] ?? null;
}

export interface DesktopSshEnvironmentLinkDependencies {
  readonly findSaved: (alias: string) => SavedSshEnvironment | null;
  readonly resolveTarget: (alias: string) => Promise<DesktopSshEnvironmentTarget>;
  readonly confirm: (message: string, destructive: boolean) => Promise<boolean | undefined>;
  readonly connect: (
    target: DesktopSshEnvironmentTarget,
    saved: SavedSshEnvironment | null,
  ) => Promise<EnvironmentId>;
  readonly openProject: (environmentId: EnvironmentId, path: string) => Promise<void>;
  readonly forget: (environmentId: EnvironmentId) => Promise<void>;
}

export async function handleDesktopSshEnvironmentLink(
  link: DesktopSshEnvironmentLink,
  dependencies: DesktopSshEnvironmentLinkDependencies,
): Promise<"opened" | "forgotten" | "cancelled" | "missing"> {
  const saved = dependencies.findSaved(link.alias);
  if (link.action === "forget" && saved === null) return "missing";
  const target =
    link.action === "forget" ? saved!.target : await dependencies.resolveTarget(link.alias);
  if (
    saved !== null &&
    link.action === "open" &&
    (target.hostname !== saved.target.hostname ||
      target.username !== saved.target.username ||
      target.port !== saved.target.port)
  ) {
    throw new Error(
      `SSH configuration for ${link.alias} changed. Update or forget its saved environment in Connections first.`,
    );
  }
  const destination = `${target.username ? `${target.username}@` : ""}${target.hostname}${target.port === null ? "" : `:${target.port}`}`;
  const message =
    link.action === "open"
      ? `Open SSH environment ${link.alias}?\nHost: ${destination}\nProject: ${link.path}\nT3 Code will connect using your SSH configuration and may install or start its server on this host.`
      : `Forget SSH environment ${link.alias}?\nHost: ${destination}\nThis forgets its pairing, credentials, and cached threads on this device. Files and threads on the remote host are kept.`;
  if ((await dependencies.confirm(message, link.action === "forget")) !== true) return "cancelled";
  if (link.action === "forget") {
    // Re-read after confirmation; a concurrent removal must not target a replacement machine.
    const current = dependencies.findSaved(link.alias);
    if (current?.environmentId !== saved!.environmentId)
      throw new Error("The saved SSH environment changed while confirming. Open the link again.");
    await dependencies.forget(saved!.environmentId);
    return "forgotten";
  }
  const current = dependencies.findSaved(link.alias);
  if (current?.environmentId !== saved?.environmentId)
    throw new Error("The saved SSH environment changed while confirming. Open the link again.");
  const environmentId = await dependencies.connect(target, saved);
  await dependencies.openProject(environmentId, link.path);
  return "opened";
}
