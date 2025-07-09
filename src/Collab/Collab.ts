import {
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $getState,
  $isElementNode,
  $isRangeSelection,
  $onUpdate,
  $setState,
  createState,
  EditorState,
  LexicalEditor,
  LexicalNode,
  NodeKey,
  NodeMutation,
  ParagraphNode,
  TextNode,
} from "lexical";
import { v7 as uuidv7 } from "uuid";
import { $dfs } from "@lexical/utils";
import {
  isPeerMessage,
  isSerializedSyncNode,
  isSyncMessageServer,
  PeerMessage,
  SyncMessageClient,
  SyncMessageServer,
} from "./Messages";

const SYNC_TAG = "SYNC_TAG";

const CURSOR_INACTIVITY_LIMIT = 10; // seconds

export type CollabCursor = {
  lastActivity: number;
  anchorElement: HTMLElement;
  anchorOffset: number;
  focusElement: HTMLElement;
  focusOffset: number;
};

type CursorListener = (cursors: Map<string, CollabCursor>) => void;

// Splits TextNodes every time the user types a space.
// This allows users to edit one paragraph without (as many) conflicts.
const wordSplitTransform = (node: TextNode): void => {
  const text = node.getTextContent();
  if (text.length <= 1) {
    return;
  }
  // Did the user just type (or visit) a space? Split the text to create more nodes.
  const selection = $getSelection();
  let spaceIndex = -1;
  if (
    $isRangeSelection(selection) &&
    selection.anchor.key === node.getKey() &&
    selection.anchor.offset <= text.length &&
    text[selection.anchor.offset - 1] === " "
  ) {
    spaceIndex = selection.anchor.offset - 1;
  }
  if (spaceIndex === -1) {
    return;
  }
  // Feels like this shouldn't be needed but I think us updating immidiately
  // on duplicate keys in onMutation is messing up the selection pretty bad.
  const nodes = node.splitText(spaceIndex);
  nodes.shift();
  nodes.forEach((node) => {
    $setState(node, syncIdState, uuidv7());
  });
};

const compareRedisStreamIds = (a: string, b: string): number => {
  return parseInt(a.split("-")[0]) - parseInt(b.split("-")[0]);
};

const SYNC_ID_UNSET = "SYNC_ID_UNSET";

const syncIdState = createState("syncId", {
  parse: (v) => (typeof v === "string" ? v : SYNC_ID_UNSET),
});

const getNodeSyncId = (node: LexicalNode): string | undefined => {
  const syncId = $getState(node, syncIdState);
  if (syncId === SYNC_ID_UNSET) {
    return;
  }
  return syncId;
};

export class CollabInstance {
  syncIdToNodeKey: Map<string, NodeKey>;
  nodeKeyToSyncId: Map<NodeKey, string>;
  editor: LexicalEditor;
  ws?: WebSocket;
  removeListenerCallbacks: (() => void)[];
  reconnectInterval?: NodeJS.Timeout;
  persistInterval?: NodeJS.Timeout;
  cursorInterval?: NodeJS.Timeout;
  flushTimer?: NodeJS.Timeout;
  userId: string;
  lastId?: string;
  lastPersistedId?: string;
  messageStack: PeerMessage[];
  onCursorsChange: CursorListener;
  cursors: Map<string, CollabCursor>;
  lastCursorMessage?: PeerMessage;

  constructor(
    userId: string,
    editor: LexicalEditor,
    onCursorsChange: CursorListener,
  ) {
    this.editor = editor;
    this.userId = userId;
    this.syncIdToNodeKey = new Map();
    this.nodeKeyToSyncId = new Map();
    this.messageStack = [];
    this.removeListenerCallbacks = [];
    this.cursors = new Map();
    this.onCursorsChange = onCursorsChange;
  }

  start() {
    clearInterval(this.reconnectInterval);
    clearInterval(this.persistInterval);
    if (this.ws) {
      this.ws.close();
    }
    this.removeListenerCallbacks = [
      // @todo Feels like we could generically support every element type?
      this.editor.registerMutationListener(
        ParagraphNode,
        this.onMutation.bind(this),
      ),
      this.editor.registerMutationListener(
        TextNode,
        this.onMutation.bind(this),
      ),
      this.editor.registerNodeTransform(TextNode, wordSplitTransform),
    ];
    this.ws = new WebSocket("ws://127.0.0.1:9045");
    this.ws.addEventListener("error", (error) => {
      console.error(error);
      this.ws?.close();
    });
    this.ws.addEventListener("open", () => this.flushStack());
    this.ws.addEventListener("message", this.onMessage.bind(this));

    this.reconnectInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === this.ws.CLOSED) {
        console.log("websocket closed, reconnecting...");
        this.start();
      }
    }, 1000);

    this.persistInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === this.ws.OPEN && this.lastId) {
        if (this.lastPersistedId && this.lastId === this.lastPersistedId) {
          return;
        }
        this.lastPersistedId = this.lastId;
        this.send({
          type: "persist-document",
          lastId: this.lastId,
          editorState: this.editor.getEditorState().toJSON(),
        });
      }
    }, 1000);

    this.cursorInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === this.ws.OPEN) {
        this.editor.read(() => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            const anchorSyncId = getNodeSyncId(selection.anchor.getNode());
            const focusSyncId = getNodeSyncId(selection.focus.getNode());
            if (anchorSyncId && focusSyncId) {
              const message: PeerMessage = {
                type: "cursor",
                lastActivity: Date.now(),
                userId: this.userId,
                anchorId: anchorSyncId,
                anchorOffset: selection.anchor.offset,
                focusId: focusSyncId,
                focusOffset: selection.focus.offset,
              };
              if (
                this.lastCursorMessage &&
                JSON.stringify(message, (key, value) =>
                  key === "lastActivity" ? 0 : value,
                ) ===
                  JSON.stringify(this.lastCursorMessage, (key, value) =>
                    key === "lastActivity" ? 0 : value,
                  )
              ) {
                return;
              }
              this.lastCursorMessage = message;
              this.send({
                type: "peer-chunk",
                messages: [message],
              });
            }
          }
        });
      }
      let cursorsChanged = false;
      this.cursors.forEach((cursor, userId) => {
        if (cursor.lastActivity < Date.now() - 1000 * CURSOR_INACTIVITY_LIMIT) {
          this.cursors.delete(userId);
          cursorsChanged = true;
        }
      });
      if (cursorsChanged) {
        this.onCursorsChange(this.cursors);
      }
    }, 100);
  }

  stop() {
    clearInterval(this.reconnectInterval);
    clearInterval(this.persistInterval);
    if (this.ws) {
      this.ws.close();
    }
    this.removeListenerCallbacks.forEach((f) => f());
  }

  send(message: SyncMessageClient): void {
    this.ws?.send(JSON.stringify(message));
  }

  mapSyncIdToNodeKey(syncId: string, nodeKey: NodeKey) {
    if (nodeKey === "root") {
      console.error(`Attempted to record root ID ${syncId} => ${nodeKey}`);
      return;
    }
    if (syncId === SYNC_ID_UNSET) {
      console.error(`Attempted to set default value ${syncId} => ${nodeKey}`);
      return;
    }
    const knownNode = this.syncIdToNodeKey.get(syncId);
    if (!knownNode) {
      this.syncIdToNodeKey.set(syncId, nodeKey);
      this.nodeKeyToSyncId.set(nodeKey, syncId);
    } else if (knownNode !== nodeKey) {
      console.error(
        `Duplicate node keys exist for ${syncId}: mapped=${knownNode}, found=${nodeKey}`,
      );
      return;
    }
  }

  populateSyncIdMap() {
    this.editor.read(() => {
      $dfs().forEach((dfsNode) => {
        if (dfsNode.node.getKey() === "root") {
          return;
        }
        this.mapSyncIdToNodeKey(
          $getState(dfsNode.node, syncIdState),
          dfsNode.node.getKey(),
        );
      });
    });
  }

  getNodeBySyncId(syncId: string): LexicalNode | undefined {
    const nodeKey = this.syncIdToNodeKey.get(syncId);
    if (!nodeKey) {
      return;
    }
    const node = $getNodeByKey(nodeKey);
    if (!node) {
      return;
    }
    return node;
  }

  flushStack() {
    if (
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN ||
      this.messageStack.length === 0
    ) {
      return;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      this.send({
        type: "peer-chunk",
        messages: this.messageStack,
      });
      this.messageStack = [];
    }, 50);
  }

  updateCursor(
    userId: string,
    anchorId: string,
    anchorOffset: number,
    focusId: string,
    focusOffset: number,
    lastActivity: number,
  ) {
    const anchorKey = this.getNodeBySyncId(anchorId)?.getKey();
    const focusKey = this.getNodeBySyncId(focusId)?.getKey();
    if (!anchorKey || !focusKey) {
      return;
    }
    const anchorElement = this.editor.getElementByKey(anchorKey);
    const focusElement = this.editor.getElementByKey(focusKey);
    if (
      !anchorElement ||
      !focusElement ||
      lastActivity < Date.now() - 1000 * CURSOR_INACTIVITY_LIMIT
    ) {
      this.cursors.delete(userId);
    } else {
      this.cursors.set(userId, {
        lastActivity,
        anchorElement,
        focusElement,
        anchorOffset,
        focusOffset,
      });
    }
    this.onCursorsChange(this.cursors);
  }

  onMutation(
    nodes: Map<NodeKey, NodeMutation>,
    {
      updateTags,
    }: {
      updateTags: Set<string>;
      dirtyLeaves: Set<string>;
      prevEditorState: EditorState;
    },
  ) {
    if (updateTags.has(SYNC_TAG)) {
      return;
    }
    // Ensure every node has a (unique) UUID
    this.editor.update(
      () => {
        nodes.forEach((mutation, nodeKey) => {
          switch (mutation) {
            case "created":
              const node = $getNodeByKey(nodeKey);
              if (!node) {
                console.error(`Node not found ${nodeKey}`);
                return;
              }
              let syncId = $getState(node, syncIdState);
              const mappedNode = this.getNodeBySyncId(syncId);
              // Brand new node or cloned node.
              if (
                syncId === SYNC_ID_UNSET ||
                (mappedNode && mappedNode.getKey() != node.getKey())
              ) {
                syncId = uuidv7();
                this.mapSyncIdToNodeKey(syncId, node.getKey());
                $setState(node.getWritable(), syncIdState, syncId);
                return;
              }
              break;
          }
        });
      },
      { tag: SYNC_TAG },
    );
    this.editor.read(() => {
      nodes.forEach((mutation, nodeKey) => {
        switch (mutation) {
          case "created":
          case "updated":
            const node = $getNodeByKey(nodeKey);
            if (!node) {
              console.error(`Node not found ${nodeKey}`);
              return;
            }
            const syncId = $getState(node, syncIdState);
            if (syncId === SYNC_ID_UNSET) {
              console.error(`Node does not have sync ID ${nodeKey}`);
              return;
            }
            this.mapSyncIdToNodeKey(syncId, nodeKey);
            const previous = node.getPreviousSibling();
            const next = node.getNextSibling();
            const parent = node.getParent();
            this.messageStack.push({
              type: "upserted",
              userId: this.userId,
              node: node.exportJSON(),
              previousId: previous ? getNodeSyncId(previous) : undefined,
              nextId: next ? getNodeSyncId(next) : undefined,
              parentId: parent ? getNodeSyncId(parent) : undefined,
            });
            break;
          case "destroyed":
            const destroyedSyncId = this.nodeKeyToSyncId.get(nodeKey);
            if (!destroyedSyncId) {
              console.error(
                `Node key never mapped for destroy message: ${nodeKey}`,
              );
              return;
            }
            this.messageStack.push({
              type: "destroyed",
              userId: this.userId,
              syncId: destroyedSyncId,
            });
            break;
        }
      });
      this.flushStack();
    });
  }

  onMessage(wsMessage: MessageEvent) {
    this.editor.update(
      () => {
        const serverMessage: SyncMessageServer = JSON.parse(wsMessage.data);
        if (!isSyncMessageServer(serverMessage)) {
          console.error(
            `Non-server message sent from server: ${wsMessage.data}`,
          );
          return;
        }
        if (serverMessage.type === "init") {
          this.lastId = serverMessage.lastId;
          const editorState = this.editor.parseEditorState(
            serverMessage.editorState,
          );
          if (!editorState.isEmpty()) {
            this.editor.setEditorState(editorState, {
              tag: SYNC_TAG,
            });
          }
          this.send({
            type: "init-received",
            userId: this.userId,
            lastId: serverMessage.lastId,
          });
          this.editor.setEditable(true);
          $onUpdate(() => this.populateSyncIdMap());
          return;
        }
        serverMessage.messages.forEach((message) => {
          if (!isPeerMessage(message)) {
            console.error(
              `Non-peer message sent from server: ${wsMessage.data}`,
            );
            return;
          }
          // Ignore and log when incoming redis ID is in the past.
          if (message.type != "cursor") {
            if (
              this.lastId &&
              message.id &&
              compareRedisStreamIds(this.lastId, message.id) > 0
            ) {
              console.error(`Out of order message detected: ${wsMessage.data}`);
              return;
            }
          }
          // Ignore messages (probably) sent by us.
          if (message.userId === this.userId) {
            if (message.type != "cursor") {
              this.lastId = message.id;
            }
            return;
          }
          switch (message.type) {
            case "upserted":
              if (message.id) {
                this.lastId = message.id;
              }
              if (!isSerializedSyncNode(message.node)) {
                console.error(`Node is of unknown type: ${wsMessage.data}`);
                return;
              }
              // Update
              const nodeToUpdate = this.getNodeBySyncId(message.node.$.syncId);
              if (nodeToUpdate) {
                nodeToUpdate.updateFromJSON(message.node);
                return;
              }
              // Insert
              let messageNode: LexicalNode;
              switch (message.node.type) {
                case "paragraph":
                  messageNode = $createParagraphNode().updateFromJSON(
                    // @ts-ignore
                    message.node,
                  );
                  break;
                case "text":
                  // @ts-ignore
                  messageNode = $createTextNode().updateFromJSON(message.node);
                  break;
                default:
                  console.error(`Got unknown type ${message.node.type}`);
                  return;
              }
              // @todo: Handle out of order inserts, maybe on the server
              if (message.previousId) {
                const previousNode = this.getNodeBySyncId(message.previousId);
                if (!previousNode) {
                  console.error(
                    `Previous key not found: ${message.previousId}`,
                  );
                  return;
                }
                previousNode.insertAfter(messageNode);
                this.mapSyncIdToNodeKey(
                  message.node.$.syncId,
                  messageNode.getKey(),
                );
              } else if (message.nextId) {
                const nextNode = this.getNodeBySyncId(message.nextId);
                if (!nextNode) {
                  console.error(`Next key not found: ${message.nextId}`);
                  return;
                }
                nextNode.insertBefore(messageNode);
                this.mapSyncIdToNodeKey(
                  message.node.$.syncId,
                  messageNode.getKey(),
                );
              } else if (message.parentId) {
                const parentNode = this.getNodeBySyncId(message.parentId);
                if (!parentNode) {
                  console.error(`Parent key not found: ${message.parentId}`);
                  return;
                }
                if (!$isElementNode(parentNode)) {
                  console.error(
                    `Parent is not an element node, can't append to ${message.parentId}`,
                  );
                  return;
                }
                parentNode.append(messageNode);
                this.mapSyncIdToNodeKey(
                  message.node.$.syncId,
                  messageNode.getKey(),
                );
              } else {
                if (messageNode.getType() === "text") {
                  console.error("text nodes cannot be appended to root");
                  return;
                }
                $getRoot().append(messageNode);
                this.mapSyncIdToNodeKey(
                  message.node.$.syncId,
                  messageNode.getKey(),
                );
              }
              break;
            case "destroyed":
              if (message.id) {
                this.lastId = message.id;
              }
              const nodeToDestroy = this.getNodeBySyncId(message.syncId);
              if (!nodeToDestroy) {
                console.error(`Destroy key not found: ${message.syncId}`);
                return;
              }
              nodeToDestroy.remove(true);
              break;
            case "cursor":
              this.updateCursor(
                message.userId,
                message.anchorId,
                message.anchorOffset,
                message.focusId,
                message.focusOffset,
                message.lastActivity,
              );
              break;
            default:
              console.error(`Unknown message type: ${wsMessage.data}`);
              return;
          }
        });
      },
      { tag: SYNC_TAG },
    );
  }
}
