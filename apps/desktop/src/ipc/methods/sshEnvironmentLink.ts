import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopClerk from "../../app/DesktopClerk.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const setReady = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SSH_ENVIRONMENT_LINK_READY_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.sshEnvironmentLink.setReady")(function* (ready) {
    const clerk = yield* DesktopClerk.DesktopClerk;
    yield* clerk.setEnvironmentLinkReady(ready);
  }),
});

export const complete = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SSH_ENVIRONMENT_LINK_COMPLETE_CHANNEL,
  payload: Schema.String,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.sshEnvironmentLink.complete")(function* (requestId) {
    const clerk = yield* DesktopClerk.DesktopClerk;
    yield* clerk.completeEnvironmentLink(requestId);
  }),
});
