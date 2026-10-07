import { useAtomValue } from "@effect/atom-react";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { DesktopSshEnvironmentLinkRequest } from "@t3tools/contracts";
import { useEffect, useEffectEvent } from "react";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../../connection/catalog";
import { connectSshEnvironment } from "../../connection/onboarding";
import { requestConfirmDialog } from "../../confirmDialog";
import {
  findSavedSshEnvironment,
  handleDesktopSshEnvironmentLink,
  waitForDesktopSshEnvironment,
} from "../../desktopSshEnvironmentLink";
import { useDesktopProjectActivation } from "../../hooks/useDesktopProjectActivation";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { serverEnvironment } from "../../state/server";
import { environmentPresentations } from "../../state/presentation";
import { environmentShell } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";

function unwrap<A, E>(result: AtomCommandResult<A, E>): A {
  if (result._tag === "Failure") {
    const error = squashAtomCommandFailure(result);
    throw error instanceof Error
      ? error
      : new Error("Could not complete the SSH environment link.");
  }
  return result.value;
}

export function DesktopSshEnvironmentLinkCoordinator() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const connect = useAtomCommand(connectSshEnvironment, { reportFailure: false });
  const setEnabled = useAtomCommand(environmentCatalog.setEnabled, { reportFailure: false });
  const retry = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const remove = useAtomCommand(environmentCatalog.remove, { reportFailure: false });
  const openProject = useDesktopProjectActivation();
  const bridge = window.desktopBridge;
  const links = bridge?.sshEnvironmentLinks;

  const processRequest = useEffectEvent(
    async (request: DesktopSshEnvironmentLinkRequest, signal: AbortSignal) => {
      if (!bridge || !links) return;
      try {
        const outcome = await handleDesktopSshEnvironmentLink(request, {
          findSaved: (alias) =>
            findSavedSshEnvironment(
              appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries,
              alias,
            ),
          resolveTarget: (alias) => bridge.resolveSshHost(alias),
          confirm: async (message, destructive) => {
            if (signal.aborted) return false;
            const confirmed = await requestConfirmDialog(message, {
              variant: destructive ? "destructive" : "default",
            });
            return !signal.aborted && confirmed === true;
          },
          connect: async (target, saved) => {
            const environmentId =
              saved?.environmentId ?? unwrap(await connect({ target, label: "" }));
            unwrap(await setEnabled({ environmentId, enabled: true }));
            if (
              saved &&
              appAtomRegistry.get(environmentPresentations.presentationAtom(environmentId))
                ?.connection.phase !== "connected"
            ) {
              unwrap(await retry(environmentId));
            }
            return environmentId;
          },
          openProject: async (environmentId, path) => {
            const readiness = Atom.make((get) => {
              const entry = get(environmentCatalog.catalogValueAtom).entries.get(environmentId);
              const connection = get(
                environmentPresentations.presentationAtom(environmentId),
              )?.connection;
              const shell = get(environmentShell.stateValueAtom(environmentId));
              return {
                ready:
                  shell.status === "live" &&
                  get(serverEnvironment.configValueAtom(environmentId)) !== null,
                error:
                  entry?.unsupportedReason ??
                  (connection?.phase === "error" || connection?.phase === "unsupported"
                    ? connection.error
                    : null) ??
                  Option.getOrNull(shell.error),
              };
            });
            await waitForDesktopSshEnvironment({
              read: () => appAtomRegistry.get(readiness),
              subscribe: (listener) => appAtomRegistry.subscribe(readiness, listener),
              signal,
            });
            const config = appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId));
            if (!config) throw new Error("The SSH environment's configuration is unavailable.");
            const platform = config.environment.platform.os;
            if (platform === "unknown")
              throw new Error("The SSH environment's operating system is unavailable.");
            const response = await openProject(
              {
                version: 1,
                type: "open-workspace",
                requestId: request.requestId,
                workspaceRoot: path,
                platform: platform === "windows" ? "win32" : platform,
              },
              () => ({ environmentId, platform }),
            );
            if (!response.ok) throw new Error(response.message);
          },
          forget: async (environmentId) => {
            unwrap(await remove(environmentId));
          },
        });
        if (outcome === "forgotten" || outcome === "missing")
          toastManager.add({
            type: "info",
            title:
              outcome === "forgotten"
                ? "SSH environment forgotten"
                : "SSH environment is not saved",
            description: request.alias,
          });
      } catch (error) {
        if (signal.aborted) return;
        toastManager.add({
          type: "error",
          title: "Could not open SSH environment link",
          description: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await links.complete(request.requestId);
      }
    },
  );

  useEffect(() => {
    if (!catalog.isReady || !links) return;
    let subscribed = true;
    const controller = new AbortController();
    const unsubscribe = links.onRequest((request) => {
      void processRequest(request, controller.signal);
    });
    queueMicrotask(() => {
      if (subscribed) void links.setReady(true).catch(() => undefined);
    });
    return () => {
      subscribed = false;
      controller.abort();
      void links.setReady(false).catch(() => undefined);
      unsubscribe();
    };
  }, [catalog.isReady, links]);
  return null;
}
