import { BusEvent } from "@/bus/bus-event"
import { Schema } from "effect"
import { MessageV2 } from "./message-v2"
import { MessageID, PartID, SessionID } from "./schema"

export const Event = {
  Started: BusEvent.define(
    "session.btw.started",
    Schema.Struct({
      sessionID: SessionID,
      turnID: MessageID,
      info: MessageV2.Assistant,
    }),
  ),
  Updated: BusEvent.define(
    "session.btw.updated",
    Schema.Struct({
      sessionID: SessionID,
      turnID: MessageID,
      info: MessageV2.Assistant,
    }),
  ),
  PartUpdated: BusEvent.define(
    "session.btw.part.updated",
    Schema.Struct({
      sessionID: SessionID,
      turnID: MessageID,
      part: MessageV2.Part,
    }),
  ),
  PartDelta: BusEvent.define(
    "session.btw.part.delta",
    Schema.Struct({
      sessionID: SessionID,
      turnID: MessageID,
      messageID: MessageID,
      partID: PartID,
      field: Schema.String,
      delta: Schema.String,
    }),
  ),
}

export * as SessionBtw from "./btw"
