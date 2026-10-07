import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { DesktopAppActivationRequest } from "@t3tools/contracts";

import {
  handleDesktopAppActivationRequest,
  type DesktopAppActivationTarget,
} from "../desktopAppActivation";
import { findProjectByPath, inferProjectTitleFromPath } from "../lib/projectPaths";
import { newProjectId } from "../lib/utils";
import { readProjects, waitForProject } from "../state/entities";
import { projectEnvironment } from "../state/projects";
import { useAtomCommand } from "../state/use-atom-command";
import { useNewThreadHandler } from "./useHandleNewThread";

/** Local CLI activation and SSH links use the same project creation and draft navigation. */
export function useDesktopProjectActivation() {
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const openThread = useNewThreadHandler();
  return (
    request: DesktopAppActivationRequest,
    getTarget: () => DesktopAppActivationTarget | null,
  ) =>
    handleDesktopAppActivationRequest(request, {
      getTarget,
      findProject: (environmentId, workspaceRoot) =>
        findProjectByPath(
          readProjects().filter((project) => project.environmentId === environmentId),
          workspaceRoot,
        ) ?? null,
      createProject: async (environmentId, workspaceRoot) => {
        const projectId = newProjectId();
        const result = await createProject({
          environmentId,
          input: {
            projectId,
            title: inferProjectTitleFromPath(workspaceRoot),
            workspaceRoot,
            createWorkspaceRootIfMissing: false,
            defaultModelSelection: null,
          },
        });
        if (result._tag === "Failure") {
          const error = squashAtomCommandFailure(result);
          throw error instanceof Error ? error : new Error("T3 Code could not add the project.");
        }
        return projectId;
      },
      waitForProject: async (projectRef) => {
        await waitForProject(projectRef);
      },
      openThread: (projectRef) => openThread(projectRef),
    });
}
