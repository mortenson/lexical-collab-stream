import { SyncMessageClient, SyncMessageServer } from "./Messages";

export type MessageListener = (message: SyncMessageServer) => void;

export type OpenListener = () => void;

export interface DebugEvent {
  direction?: "up" | "down";
  type: string;
  message?: string;
  nestedMessages?: string[];
}

export type DebugListener = (event: DebugEvent) => void;

export interface CollabNetwork {
  isOpen(): boolean;

  close(): void;

  connect(): void;

  send(message: SyncMessageClient): void;

  registerMessageListener(listener: MessageListener): void;

  registerOpenListener(listener: OpenListener): void;

  registerDebugListener(listener: DebugListener): void;
}

export function debugEventSyncMessage(
  direction: "up" | "down",
  m: SyncMessageClient | SyncMessageServer,
): DebugEvent {
  let message;
  const nestedMessages: string[] = [];
  switch (m.type) {
    case "init":
      message = `lastId: ${m.lastId}|firstId: ${m.firstId}`;
      break;
    case "init-received":
      message = `lastId: ${m.lastId}`;
      break;
    case "peer-chunk":
      m.messages.forEach((pm) => {
        let nestedMessage;
        switch (pm.type) {
          case "created":
            nestedMessage = `${pm.userId} created: ${pm.node.$.syncId}|previousId: ${pm.previousId}|parentId: ${pm.parentId}|streamId: ${pm.streamId}`;
            break;
          case "destroyed":
            nestedMessage = `${pm.userId} destroyed: ${pm.node.$.syncId}|streamId: ${pm.streamId}`;
            break;
          case "updated":
            nestedMessage = `${pm.userId} updated: ${pm.node.$.syncId}|streamId: ${pm.streamId}`;
            break;
          case "cursor":
            nestedMessage = `${pm.userId} moved cursor|anchorId: ${pm.anchorId}|anchorOffset: ${pm.anchorOffset}|focusId: ${pm.focusId}|focusOffset: ${pm.focusOffset}|streamId: ${pm.streamId}`;
            break;
          default:
            nestedMessage = `unknown message type: ${JSON.stringify(pm)}`;
            break;
        }
        nestedMessages.push(nestedMessage);
      });
      break;
    case "persist-document":
      message = `lastId: ${m.lastId}`;
      break;
    default:
      message = `unknown message type: ${JSON.stringify(m)}`;
      break;
  }
  return {
    type: m.type,
    direction,
    message,
    nestedMessages,
  };
}
