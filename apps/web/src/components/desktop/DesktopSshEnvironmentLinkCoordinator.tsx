import { useAtomValue } from "@effect/atom-react";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { DesktopSshEnvironmentLinkRequest } from "@t3tools/contracts";
import { useEffect, useEffectEvent } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { connectSshEnvironment } from "../../connection/onboarding";
import { requestConfirmDialog } from "../../confirmDialog";
import {
  findSavedSshEnvironment,
  handleDesktopSshEnvironmentLink,
} from "../../desktopSshEnvironmentLink";
import { useDesktopProjectActivation } from "../../hooks/useDesktopProjectActivation";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { serverEnvironment } from "../../state/server";
import { environmentPresentations } from "../../state/presentation";
import { environmentShell } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { waitForAtomValue } from "../../state/waitForAtomValue";
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

  const processRequest = useEffectEvent(async (request: DesktopSshEnvironmentLinkRequest) => {
    if (!bridge || !links) return;
    try {
      const outcome = await handleDesktopSshEnvironmentLink(request, {
        findSaved: (alias) =>
          findSavedSshEnvironment(
            appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries,
            alias,
          ),
        resolveTarget: (alias) => bridge.resolveSshHost(alias),
        confirm: async (message, destructive) =>
          requestConfirmDialog(message, { variant: destructive ? "destructive" : "default" }),
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
          const ready = await waitForAtomValue({
            registry: appAtomRegistry,
            atom: environmentShell.stateValueAtom(environmentId),
            predicate: (state) => state.status === "live",
            timeoutMs: 10_000,
          });
          if (!ready)
            throw new Error(
              "The SSH environment did not finish connecting. Retry the link or check Connections.",
            );
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
            outcome === "forgotten" ? "SSH environment forgotten" : "SSH environment is not saved",
          description: request.alias,
        });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not open SSH environment link",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await links.complete(request.requestId);
    }
  });

  useEffect(() => {
    if (!catalog.isReady || !links) return;
    let subscribed = true;
    const unsubscribe = links.onRequest((request) => {
      void processRequest(request);
    });
    queueMicrotask(() => {
      if (subscribed) void links.setReady(true).catch(() => undefined);
    });
    return () => {
      subscribed = false;
      void links.setReady(false).catch(() => undefined);
      unsubscribe();
    };
  }, [catalog.isReady, links]);
  return null;
}
