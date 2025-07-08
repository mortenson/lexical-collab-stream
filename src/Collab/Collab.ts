import {
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $getState,
  $isElementNode,
  $isRangeSelection,
  $onUpdate,
  $setState,
  EditorState,
  LexicalEditor,
  LexicalNode,
  NodeKey,
  NodeMutation,
  PASTE_TAG,
} from "lexical";
import { v7 as uuidv7 } from "uuid";
import {
  $createSyncParagraphNode,
  $createSyncTextNode,
  getNodeSyncId,
  SerializedSyncParagraphNode,
  SerializedSyncTextNode,
  SYNC_ID_UNSET,
  syncIdState,
  SyncParagraphNode,
  SyncTextNode,
} from "./Nodes";
import { $dfs } from "@lexical/utils";
import {
  isSyncMessageServer,
  SerializedSyncNode,
  SyncMessage,
  SyncMessageClient,
} from "./Messages";

export const SYNC_TAG = "SYNC_TAG";
export const CLOSE_INTENTIONAL_CODE = 3001;

// Splits TextNodes every time the user types a space.
// This allows users to edit one paragraph without (as many) conflicts.
const wordSplitTransform = (node: SyncTextNode): void => {
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
  node.splitText(spaceIndex);
};

const compareRedisStreamIds = (a: string, b: string): number => {
  return parseInt(a.split("-")[0]) - parseInt(b.split("-")[0]);
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

  userId: string;

  lastId?: string;

  messageStack: SyncMessageClient[];

  constructor(userId: string, editor: LexicalEditor) {
    this.editor = editor;
    this.userId = userId;
    this.syncIdToNodeKey = new Map();
    this.nodeKeyToSyncId = new Map();
    this.messageStack = [];
    this.removeListenerCallbacks = [];
  }

  start() {
    clearInterval(this.reconnectInterval);
    clearInterval(this.persistInterval);
    if (this.ws) {
      this.ws.close();
    }
    this.removeListenerCallbacks = [
      this.editor.registerMutationListener(
        SyncParagraphNode,
        this.onMutation.bind(this),
      ),
      this.editor.registerMutationListener(
        SyncTextNode,
        this.onMutation.bind(this),
      ),
      this.editor.registerNodeTransform(SyncTextNode, wordSplitTransform),
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
        this.send([
          {
            type: "persist-document",
            lastId: this.lastId,
            editorState: this.editor.getEditorState().toJSON(),
          },
        ]);
      }
    }, 1000);

    this.cursorInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === this.ws.OPEN) {
        this.editor.read(() => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            const element = this.editor.getElementByKey(selection.anchor.key);
            if (
              !element ||
              !element.firstChild ||
              element.firstChild.nodeType !== element.firstChild.TEXT_NODE
            ) {
              return;
            }
            const range = document.createRange();
            range.setStart(element.firstChild, selection.anchor.offset);
            const clientRect = range.getBoundingClientRect();
            const highlight = document.getElementById("highlight");
            if (!highlight) {
              return;
            }
            highlight.style.left = `${clientRect.x}px`;
            highlight.style.top = `${clientRect.y}px`;
            // highlight.style.width = `${clientRect.width}px`;
            highlight.style.height = `${clientRect.height}px`;
          }
        });
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

  send(messages: SyncMessageClient[]): void {
    this.ws?.send(JSON.stringify(messages));
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
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.send(this.messageStack);
    this.messageStack = [];
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
    // @todo file issue with lexical to make some kind of "forreal clone"
    // concept so that we can generate new UUIDs when a command/plugin is
    // actually trying to make a real clone with a new NodeKey
    if (updateTags.has(PASTE_TAG)) {
      this.editor.update(() => {
        nodes.forEach((mutation, nodeKey) => {
          switch (mutation) {
            case "created":
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
              // The pasted node is already mapped, give it a new UUID.
              // @todo: This might be evidence that all UUIDs should be
              // assigned in the mutation listener, not the Node class.
              if (this.getNodeBySyncId(syncId)) {
                $setState(node, syncIdState, uuidv7());
              }
              break;
          }
        });
      });
    }
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
              node: node.exportJSON() as SerializedSyncNode,
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
        const message: SyncMessage = JSON.parse(wsMessage.data);
        if (!isSyncMessageServer(message)) {
          console.error(
            `Non-server message sent from server: ${wsMessage.data}`,
          );
          return;
        }
        if ("userId" in message) {
          // Ignore and log when incoming redis ID is in the past.
          if (
            this.lastId &&
            message.id &&
            compareRedisStreamIds(this.lastId, message.id) > 0
          ) {
            console.error(`Out of order message detected: ${wsMessage.data}`);
            return;
          }
          // Ignore own messages for sanity's sake.
          else if (message.userId === this.userId) {
            this.lastId = message.id;
            return;
          }
        }
        switch (message.type) {
          case "init":
            this.lastId = message.lastId;
            const editorState = this.editor.parseEditorState(
              message.editorState,
            );
            if (!editorState.isEmpty()) {
              this.editor.setEditorState(editorState, {
                tag: SYNC_TAG,
              });
            }
            this.send([
              {
                type: "init-received",
                lastId: message.lastId,
              },
            ]);
            this.editor.setEditable(true);
            $onUpdate(() => this.populateSyncIdMap());
            break;
          case "upserted":
            if (message.id) {
              this.lastId = message.id;
            }
            // Update
            const nodeToUpdate = this.getNodeBySyncId(message.node.syncId);
            if (nodeToUpdate) {
              nodeToUpdate.updateFromJSON(message.node);
              return;
            }
            // Insert
            let messageNode: LexicalNode;
            switch (message.node.type) {
              case "sync-paragraph":
                messageNode = $createSyncParagraphNode().updateFromJSON(
                  message.node as SerializedSyncParagraphNode,
                );
                break;
              case "sync-text":
                messageNode = $createSyncTextNode().updateFromJSON(
                  message.node as SerializedSyncTextNode,
                );
                break;
              default:
                console.error(`Got unknown type ${message.node.type}`);
                return;
            }
            // @todo: Handle out of order inserts, maybe on the server
            if (message.previousId) {
              const previousNode = this.getNodeBySyncId(message.previousId);
              if (!previousNode) {
                console.error(`Previous key not found: ${message.previousId}`);
                return;
              }
              previousNode.insertAfter(messageNode);
              this.mapSyncIdToNodeKey(
                message.node.syncId,
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
                message.node.syncId,
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
                message.node.syncId,
                messageNode.getKey(),
              );
            } else {
              if (messageNode.getType() === "sync-text") {
                console.error("text nodes cannot be appended to root");
                return;
              }
              $getRoot().append(messageNode);
              this.mapSyncIdToNodeKey(
                message.node.syncId,
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
          default:
            console.error(`Unknown message type: ${wsMessage.data}`);
            return;
        }
      },
      { tag: SYNC_TAG },
    );
  }
}
