import type { DesktopSshEnvironmentLinkRequest } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  DesktopSshEnvironmentLinkQueue,
  readDesktopSshEnvironmentLink,
} from "./DesktopSshEnvironmentLink.ts";

const link =
  "t3code://environments/ssh?alias=shardflux-shardflux-main&path=%2Fhome%2Fuser%2Fshardflux";

describe("SSH environment links", () => {
  it("reads the proposed link and an encoded directory with spaces", () => {
    expect(readDesktopSshEnvironmentLink(link, false)).toEqual({
      action: "open",
      alias: "shardflux-shardflux-main",
      path: "/home/user/shardflux",
    });
    expect(
      readDesktopSshEnvironmentLink(link.replace("%2Fshardflux", "%2Fmy%20project"), false),
    ).toEqual({ action: "open", alias: "shardflux-shardflux-main", path: "/home/user/my project" });
  });
  it("reads forget without requiring a project directory", () => {
    expect(
      readDesktopSshEnvironmentLink(
        "t3code://environments/ssh/forget?alias=shardflux-shardflux-main",
        false,
      ),
    ).toEqual({ action: "forget", alias: "shardflux-shardflux-main" });
  });
  it("keeps development links separate from the installed app", () => {
    expect(readDesktopSshEnvironmentLink(link, true)).toBeNull();
    expect(
      readDesktopSshEnvironmentLink(link.replace("t3code:", "t3code-dev:"), true)?.action,
    ).toBe("open");
  });
  it.each([
    link.replace("t3code:", "https:"),
    link.replace("environments", "app"),
    link.replace("environments", "user@environments"),
    link.replace("environments", "environments:22"),
    `${link}#extra`,
    `${link}&alias=other`,
    `${link}&token=secret`,
    `${link}&path=%2Fother`,
    link.replace("shardflux-shardflux-main", "-oProxyCommand=bad"),
    link.replace("shardflux-shardflux-main", "user%40host"),
    link.replace("shardflux-shardflux-main", "host%0Aother"),
    link.replace("%2Fhome%2Fuser%2Fshardflux", "relative"),
    link.replace("%2Fhome%2Fuser%2Fshardflux", "%2Ftmp%00bad"),
    link.replace("%2Fhome%2Fuser%2Fshardflux", "%2Ftmp%FF"),
    link.replace("%2Fhome%2Fuser%2Fshardflux", "%2Ftmp%ZZ"),
    "t3code://environments/ssh?alias=host",
    "t3code://environments/ssh?alias=&path=/tmp",
    "t3code://environments/ssh/forget?alias=host&path=/tmp",
    `t3code://environments/ssh?alias=${"a".repeat(256)}&path=/tmp`,
    `t3code://environments/ssh?alias=host&path=/${"a".repeat(4096)}`,
  ])("rejects invalid input %s", (url) => {
    expect(readDesktopSshEnvironmentLink(url, false)).toBeNull();
  });
});

describe("SSH link delivery", () => {
  it("holds startup links, deduplicates pending requests, and delivers one at a time", () => {
    const queue = new DesktopSshEnvironmentLinkQueue();
    const open = { action: "open" as const, alias: "host", path: "/project" };
    const received: DesktopSshEnvironmentLinkRequest[] = [];
    queue.enqueue(open);
    queue.enqueue(open);
    queue.enqueue({ action: "forget", alias: "host" });
    queue.setRenderer((request) => received.push(request));
    expect(received.map((request) => request.action)).toEqual(["open"]);
    queue.complete("unrelated");
    expect(received).toHaveLength(1);
    queue.complete(received[0]!.requestId);
    expect(received.map((request) => request.action)).toEqual(["open", "forget"]);
    queue.complete(received[1]!.requestId);
    queue.setRenderer(null);
    queue.setRenderer((request) => received.push(request));
    expect(received).toHaveLength(2);
  });
  it("redelivers an unfinished link after renderer navigation", () => {
    const queue = new DesktopSshEnvironmentLinkQueue();
    const received: DesktopSshEnvironmentLinkRequest[] = [];
    queue.enqueue({ action: "forget", alias: "host" });
    queue.setRenderer((request) => received.push(request));
    queue.setRenderer(null);
    queue.setRenderer((request) => received.push(request));
    expect(received).toHaveLength(2);
    expect(received[0]).toEqual(received[1]);
  });
});
