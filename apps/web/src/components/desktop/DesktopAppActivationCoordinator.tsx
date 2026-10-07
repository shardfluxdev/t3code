import type { DesktopAppActivationRequest } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef } from "react";

import { useDesktopProjectActivation } from "../../hooks/useDesktopProjectActivation";
import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { environmentShell } from "../../state/shell";

export function DesktopAppActivationCoordinator() {
  const primaryEnvironment = usePrimaryEnvironment();
  const openProject = useDesktopProjectActivation();
  const queueRef = useRef(Promise.resolve());
  const activation = window.desktopBridge?.appActivation;
  const shell = useEnvironmentQuery(
    primaryEnvironment === null
      ? null
      : environmentShell.stateAtom(primaryEnvironment.environmentId),
  );
  const ready =
    activation !== undefined &&
    primaryEnvironment?.connection.phase === "connected" &&
    primaryEnvironment.serverConfig !== null &&
    shell.data?.snapshot._tag === "Some";

  const processRequest = useEffectEvent(async (request: DesktopAppActivationRequest) =>
    openProject(request, () => {
      if (
        primaryEnvironment?.connection.phase !== "connected" ||
        primaryEnvironment.serverConfig === null
      )
        return null;
      return {
        environmentId: primaryEnvironment.environmentId,
        platform: primaryEnvironment.serverConfig.environment.platform.os,
      };
    }),
  );

  useEffect(() => {
    if (!ready || activation === undefined) return;

    let subscribed = true;
    const unsubscribe = activation.onRequest((request) => {
      queueRef.current = queueRef.current.then(async () => {
        const response = await processRequest(request);
        await activation.complete(response);
      });
      queueRef.current = queueRef.current.catch(() => undefined);
    });
    // Skip readiness if React runs cleanup before this subscription can receive requests.
    queueMicrotask(() => {
      if (subscribed) void activation.setReady(true).catch(() => undefined);
    });
    return () => {
      subscribed = false;
      void activation.setReady(false).catch(() => undefined);
      unsubscribe();
    };
  }, [activation, ready]);

  return null;
}
