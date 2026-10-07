import {
  BearerConnectionTarget,
  SshConnectionProfile,
  SshConnectionTarget,
  type ConnectionCatalogEntry,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  findSavedSshEnvironment,
  handleDesktopSshEnvironmentLink,
  type DesktopSshEnvironmentLinkDependencies,
} from "./desktopSshEnvironmentLink";

// Captured from `ssh -G shardflux-shardflux-main` on 2026-10-07; no SSH credentials.
const target = {
  alias: "shardflux-shardflux-main",
  hostname: "shardflux-shardflux-main",
  username: "user",
  port: 22,
};
const environmentId = EnvironmentId.make("ssh-machine");
const saved = { environmentId, target };
const link = { action: "open" as const, alias: target.alias, path: "/home/user/shardflux" };

function dependencies(overrides: Partial<DesktopSshEnvironmentLinkDependencies> = {}) {
  return {
    findSaved: vi.fn(() => null),
    resolveTarget: vi.fn(async () => target),
    confirm: vi.fn(async () => true),
    connect: vi.fn(async () => environmentId),
    openProject: vi.fn(async () => undefined),
    forget: vi.fn(async () => undefined),
    ...overrides,
  } satisfies DesktopSshEnvironmentLinkDependencies;
}

function sshEntry(id = environmentId): ConnectionCatalogEntry {
  return {
    enabled: false,
    target: new SshConnectionTarget({
      environmentId: id,
      label: "Remote",
      connectionId: `ssh:${id}`,
    }),
    profile: Option.some(
      new SshConnectionProfile({
        environmentId: id,
        label: "Remote",
        connectionId: `ssh:${id}`,
        target,
      }),
    ),
  };
}

describe("saved SSH alias lookup", () => {
  it("finds disabled environments and alternate SSH routes", () => {
    const ssh = sshEntry();
    const entry = {
      ...ssh,
      target: new BearerConnectionTarget({ environmentId, label: "Remote", connectionId: "lan" }),
      profile: Option.none(),
      alternateRoutes: [{ target: ssh.target, profile: ssh.profile }],
    };
    expect(findSavedSshEnvironment(new Map([[environmentId, entry]]), target.alias)).toEqual(saved);
    expect(findSavedSshEnvironment(new Map([[environmentId, entry]]), "missing")).toBeNull();
  });
  it("refuses ambiguous aliases rather than forgetting a guessed machine", () => {
    const other = EnvironmentId.make("other-machine");
    expect(() =>
      findSavedSshEnvironment(
        new Map([
          [environmentId, sshEntry()],
          [other, sshEntry(other)],
        ]),
        target.alias,
      ),
    ).toThrow("More than one");
  });
});

describe("SSH environment link behavior", () => {
  it("shows the resolved host and project before provisioning and focusing", async () => {
    const deps = dependencies();
    expect(await handleDesktopSshEnvironmentLink(link, deps)).toBe("opened");
    expect(deps.confirm).toHaveBeenCalledWith(
      expect.stringContaining(
        "Host: user@shardflux-shardflux-main:22\nProject: /home/user/shardflux",
      ),
      false,
    );
    expect(vi.mocked(deps.confirm).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.connect).mock.invocationCallOrder[0]!,
    );
    expect(deps.connect).toHaveBeenCalledWith(target, null);
    expect(deps.openProject).toHaveBeenCalledWith(environmentId, link.path);
  });
  it.each([false, undefined])(
    "performs no mutations when confirmation returns %s",
    async (confirmed) => {
      const deps = dependencies({ confirm: vi.fn(async () => confirmed) });
      expect(await handleDesktopSshEnvironmentLink(link, deps)).toBe("cancelled");
      expect(deps.connect).not.toHaveBeenCalled();
      expect(deps.openProject).not.toHaveBeenCalled();
      expect(deps.forget).not.toHaveBeenCalled();
    },
  );
  it("reuses the saved environment identity", async () => {
    const deps = dependencies({ findSaved: () => saved });
    await handleDesktopSshEnvironmentLink(link, deps);
    expect(deps.connect).toHaveBeenCalledWith(target, saved);
    expect(deps.openProject).toHaveBeenCalledWith(environmentId, link.path);
  });
  it("refuses changed host resolution before connecting", async () => {
    const deps = dependencies({
      findSaved: () => saved,
      resolveTarget: async () => ({ ...target, hostname: "different-machine" }),
    });
    await expect(handleDesktopSshEnvironmentLink(link, deps)).rejects.toThrow("configuration");
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.connect).not.toHaveBeenCalled();
  });
  it("forgets using the saved host after its config alias was removed", async () => {
    const deps = dependencies({ findSaved: () => saved });
    expect(
      await handleDesktopSshEnvironmentLink({ action: "forget", alias: target.alias }, deps),
    ).toBe("forgotten");
    expect(deps.resolveTarget).not.toHaveBeenCalled();
    expect(deps.confirm).toHaveBeenCalledWith(
      expect.stringContaining("Host: user@shardflux-shardflux-main:22"),
      true,
    );
    expect(deps.forget).toHaveBeenCalledWith(environmentId);
    expect(deps.connect).not.toHaveBeenCalled();
  });
  it("keeps a missing forget link idempotent without making a connection", async () => {
    const deps = dependencies();
    expect(
      await handleDesktopSshEnvironmentLink({ action: "forget", alias: target.alias }, deps),
    ).toBe("missing");
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.resolveTarget).not.toHaveBeenCalled();
    expect(deps.forget).not.toHaveBeenCalled();
  });
  it("does not open a project when SSH connection fails", async () => {
    const deps = dependencies({
      connect: async () => {
        throw new Error("SSH failed");
      },
    });
    await expect(handleDesktopSshEnvironmentLink(link, deps)).rejects.toThrow("SSH failed");
    expect(deps.openProject).not.toHaveBeenCalled();
  });
  it("does not forget a replacement selected while confirmation was open", async () => {
    const findSaved = vi
      .fn()
      .mockReturnValueOnce(saved)
      .mockReturnValue({ ...saved, environmentId: EnvironmentId.make("replacement") });
    const deps = dependencies({ findSaved });
    await expect(
      handleDesktopSshEnvironmentLink({ action: "forget", alias: target.alias }, deps),
    ).rejects.toThrow("changed while confirming");
    expect(deps.forget).not.toHaveBeenCalled();
  });
});
