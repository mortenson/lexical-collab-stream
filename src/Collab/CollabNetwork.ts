import { SyncMessageClient, SyncMessageServer } from "./Messages";

export type MessageListener = (message: SyncMessageServer) => void;

export type OpenListener = () => void;

export interface CollabNetwork {
  isOpen(): boolean;

  close(): void;

  connect(): void;

  send(message: SyncMessageClient): void;

  registerMessageListener(listener: MessageListener): void;

  registerOpenListener(listener: OpenListener): void;
}
