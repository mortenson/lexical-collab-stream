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
  COMMAND_PRIORITY_CRITICAL,
  createState,
  EditorState,
  LexicalEditor,
  LexicalNode,
  NodeKey,
  NodeMutation,
  ParagraphNode,
  REDO_COMMAND,
  SerializedLexicalNode,
  SKIP_DOM_SELECTION_TAG,
  TextNode,
  UNDO_COMMAND,
} from "lexical";
import { v7 as uuidv7 } from "uuid";
import { $dfs } from "@lexical/utils";
import {
  CursorMessage,
  isPeerMessage,
  isSerializedSyncNode,
  isSyncMessageServer,
  NodeMessageBase,
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

// Allows JSON exporting for a node that isn't in the editor state.
// This is, uh, pretty gross since it overrides getLatest(), but I think the
// alternative is keeping a Map of destroyed NodeKeys to JSON which seems worse
const exportNonLatestJSON = (node: LexicalNode): SerializedLexicalNode => {
  const proto = Object.getPrototypeOf(node);
  const oldGetLatest = proto.getLatest;
  proto.getLatest = function () {
    return this;
  };
  const json = node.exportJSON();
  proto.getLatest = oldGetLatest;
  return json;
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
  undoStack: PeerMessage[][];
  redoStack: PeerMessage[][];
  onCursorsChange: CursorListener;
  cursors: Map<string, CollabCursor>;
  lastCursorMessage?: PeerMessage;
  undoCommandRunning: boolean;
  shouldReconnect: boolean;

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
    this.undoStack = [];
    this.redoStack = [];
    this.removeListenerCallbacks = [];
    this.cursors = new Map();
    this.onCursorsChange = onCursorsChange;
    this.undoCommandRunning = false;
    this.shouldReconnect = false;
  }

  // Splits text nodes into words.
  // This allows editors to collaborate on the same paragraph without conflict,
  // especially in cases where clients reconnect (OT has a hard time here).
  wordSplitTransform(node: TextNode): void {
    const text = node.getTextContent();
    if (text.length <= 1) {
      return;
    }
    const spaceIndex = text.indexOf(" ");
    if (spaceIndex === -1) {
      return;
    }
    const selection = $getSelection();
    const leftSide = text.substring(0, spaceIndex);
    const rightSide = text.substring(spaceIndex + 1);
    let spaceNode = $createTextNode(" ");
    if (!spaceNode.isUnmergeable()) {
      spaceNode.toggleUnmergeable();
    }
    const spaceNodeId = uuidv7();
    this.mapSyncIdToNodeKey(spaceNode.getKey(), spaceNodeId);
    $setState(spaceNode, syncIdState, spaceNodeId);
    if (leftSide.length !== 0) {
      node.setTextContent(leftSide);
      node.insertAfter(spaceNode);
    } else {
      node.setTextContent(" ");
      spaceNode = node;
    }
    if (rightSide.length !== 0) {
      const rightSideNode = $createTextNode(rightSide);
      const rightSideNodeId = uuidv7();
      this.mapSyncIdToNodeKey(rightSideNode.getKey(), rightSideNodeId);
      $setState(rightSideNode, syncIdState, rightSideNodeId);
      spaceNode.insertAfter(rightSideNode);
    }
    // "Fix" selection since we messed with nodes
    if (
      $isRangeSelection(selection) &&
      selection.focus.getNode().getKey() === node.getKey()
    ) {
      if (node.getTextContent().length < selection.focus.offset) {
        node.selectNext(
          selection.focus.offset - node.getTextContent().length,
          selection.focus.offset - node.getTextContent().length,
        );
      }
    }
  }

  // Starts collaboration. Should be called once in a useEffect hook.
  start() {
    clearInterval(this.reconnectInterval);
    clearInterval(this.persistInterval);
    this.connect();
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
      this.editor.registerNodeTransform(
        TextNode,
        this.wordSplitTransform.bind(this),
      ),
      this.editor.registerCommand(
        UNDO_COMMAND,
        this.undoCommand.bind(this),
        COMMAND_PRIORITY_CRITICAL,
      ),
      this.editor.registerCommand(
        REDO_COMMAND,
        this.redoCommand.bind(this),
        COMMAND_PRIORITY_CRITICAL,
      ),
    ];

    this.reconnectInterval = setInterval(() => {
      if (
        this.ws &&
        this.ws.readyState === this.ws.CLOSED &&
        this.shouldReconnect
      ) {
        console.error("websocket closed, reconnecting...");
        this.connect();
      }
    }, 1000);

    this.persistInterval = setInterval(this.persist.bind(this), 1000);

    this.cursorInterval = setInterval(() => {
      this.sendCursor();
      this.cleanupInactiveCursors();
    }, 100);
  }

  // Connects to the remote websocket server.
  // Can be called multiple times.
  connect() {
    this.ws?.close();
    this.ws = new WebSocket("ws://127.0.0.1:9045");
    this.ws.addEventListener("error", (error) => {
      console.error(error);
      this.ws?.close();
    });
    this.ws.addEventListener("open", () => this.flushStack());
    this.ws.addEventListener("message", this.onMessage.bind(this));
  }

  // Stops collaboration and unbinds events from the editor.
  // Should only be called when component unmounts.
  stop() {
    clearInterval(this.reconnectInterval);
    clearInterval(this.persistInterval);
    clearTimeout(this.flushTimer);
    clearTimeout(this.cursorInterval);
    this.ws?.close();
    this.removeListenerCallbacks.forEach((f) => f());
    this.removeListenerCallbacks = [];
  }

  // Sends a websocket message to the server.
  send(message: SyncMessageClient): void {
    this.ws?.send(JSON.stringify(message));
  }

  // Maps a sync ID (UUID) to a NodeKey.
  mapSyncIdToNodeKey(syncId: string, nodeKey: NodeKey) {
    // Happens on init, expected.
    if (nodeKey === "root") {
      return;
    }
    if (syncId === SYNC_ID_UNSET) {
      console.error(`Attempted to set default value ${syncId} => ${nodeKey}`);
      return;
    }
    this.syncIdToNodeKey.set(syncId, nodeKey);
    this.nodeKeyToSyncId.set(nodeKey, syncId);
  }

  // Populates our UUID <=> NodeKey maps after initializing editor state.
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

  // Fetches a node by its sync ID.
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

  // Sends our stack of messages to the server.
  // This allows for flexible batches of messages and offline editing.
  flushStack() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      if (
        !this.ws ||
        this.ws.readyState !== WebSocket.OPEN ||
        this.messageStack.length === 0
      ) {
        return;
      }
      let stack = this.messageStack;
      this.messageStack = [];
      // Flatten the stack to avoid sending duplicative messages.
      const messageMap: Map<string, PeerMessage> = new Map();
      stack.forEach((m) => {
        let existing;
        switch (m.type) {
          case "cursor":
            messageMap.set("cursor", m);
            break;
          // todo: remove all messages for children of destroyed nodes
          case "destroyed":
            existing = messageMap.get(m.node.$.syncId);
            // No reason to tell peers to delete a node we created.
            if (existing && existing.type === "created") {
              messageMap.delete(m.node.$.syncId);
            } else {
              messageMap.set(m.node.$.syncId, m);
            }
            break;
          case "created":
          case "updated":
            existing = messageMap.get(m.node.$.syncId);
            if (existing && existing.type === "created") {
              // Better to just update the created message with updated node
              existing.node = m.node;
              messageMap.set(m.node.$.syncId, existing);
            } else if (!existing || existing?.type !== "destroyed") {
              messageMap.set(m.node.$.syncId, m);
            }
            break;
        }
      });
      const flatStack = Array.from(messageMap.values());
      if (!this.undoCommandRunning) {
        this.undoStack.push(flatStack);
      } else {
        this.undoCommandRunning = false;
      }
      this.send({
        type: "peer-chunk",
        messages: flatStack,
      });
    }, 50);
  }

  // Updates our cursor for a peer based on an incoming message.
  updatePeerCursor({
    userId,
    anchorId,
    anchorOffset,
    focusId,
    focusOffset,
    lastActivity,
  }: CursorMessage) {
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

  // Responds to mutation events in nodes to send our mutations to peers.
  onMutation(
    nodes: Map<NodeKey, NodeMutation>,
    {
      updateTags,
      prevEditorState,
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
      { tag: [SYNC_TAG, SKIP_DOM_SELECTION_TAG] },
    );
    this.editor.read(() => {
      nodes.forEach((mutation, nodeKey) => {
        let previous, parent, node, syncId;
        switch (mutation) {
          case "created":
          case "updated":
            node = $getNodeByKey(nodeKey);
            if (!node) {
              console.error(`Node not found ${nodeKey}`);
              return;
            }
            syncId = $getState(node, syncIdState);
            if (syncId === SYNC_ID_UNSET) {
              console.error(`Node does not have sync ID ${nodeKey}`);
              return;
            }
            this.mapSyncIdToNodeKey(syncId, nodeKey);
            previous = node.getPreviousSibling();
            parent = node.getParent();
            const previousNode = $getNodeByKey(nodeKey, prevEditorState);
            this.messageStack.push({
              type: mutation,
              userId: this.userId,
              // @ts-ignore
              node: node.exportJSON(),
              previousId: previous ? getNodeSyncId(previous) : undefined,
              parentId: parent ? getNodeSyncId(parent) : undefined,
              ...(mutation === "updated" && previousNode
                ? {
                    previousNode: exportNonLatestJSON(previousNode),
                  }
                : {}),
            });
            break;
          case "destroyed":
            syncId = this.nodeKeyToSyncId.get(nodeKey);
            if (!syncId) {
              console.error(
                `Node key never mapped for destroy message: ${nodeKey}`,
              );
              return;
            }
            node = $getNodeByKey(nodeKey, prevEditorState);
            if (!node) {
              console.error(
                `Destroyed node not found in previous editor state ${nodeKey}`,
              );
              return;
            }
            this.messageStack.push({
              type: "destroyed",
              userId: this.userId,
              // Storing the destroyed node's JSON supports undo, and probably
              // some conflict resolution in clients in the future.
              // @ts-ignore
              node: exportNonLatestJSON(node),
              previousId: node.__prev
                ? this.nodeKeyToSyncId.get(node.__prev)
                : undefined,
              parentId: node.__parent
                ? this.nodeKeyToSyncId.get(node.__parent)
                : undefined,
            });
            break;
        }
      });
      this.flushStack();
    });
  }

  // Responds to incoming websocket messages, often broadcast from peers.
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
        // The server sends up this event time we connect.
        if (serverMessage.type === "init") {
          // We've reconnected, don't want to override our editor state.
          if (this.lastId) {
            this.send({
              type: "init-received",
              userId: this.userId,
              lastId: this.lastId,
            });
            return;
          }
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
              message.streamId &&
              compareRedisStreamIds(this.lastId, message.streamId) > 0
            ) {
              console.error(`Out of order message detected: ${wsMessage.data}`);
              return;
            }
          }
          // Ignore messages (probably) sent by us.
          if (message.userId === this.userId) {
            if (message.type != "cursor") {
              this.lastId = message.streamId;
            }
            return;
          }
          this.applyMessage(message);
        });
      },
      { tag: [SYNC_TAG, SKIP_DOM_SELECTION_TAG] },
    );
  }

  // Applies peer mutations to local editor state.
  applyMessage(message: PeerMessage) {
    switch (message.type) {
      case "created":
      case "updated":
        if (message.streamId) {
          this.lastId = message.streamId;
        }
        if (!isSerializedSyncNode(message.node)) {
          console.error(
            `Node is of unknown type: ${JSON.stringify(message.node)}`,
          );
          return;
        }
        // Update
        const nodeToUpdate = this.getNodeBySyncId(message.node.$.syncId);
        if (nodeToUpdate) {
          nodeToUpdate.updateFromJSON(message.node);
          return;
        }
        // Insert
        this.createNodeFromMessage(message);
        break;
      case "destroyed":
        if (message.streamId) {
          this.lastId = message.streamId;
        }
        const nodeToDestroy = this.getNodeBySyncId(message.node.$.syncId);
        if (!nodeToDestroy) {
          console.error(`Destroy key not found: ${message.node.$.syncId}`);
          return;
        }
        nodeToDestroy.remove(true);
        break;
      case "cursor":
        this.updatePeerCursor(message);
        break;
      default:
        console.error(`Unknown message type: ${JSON.stringify(message)}`);
        return;
    }
  }

  // Attempts to undo an applyMessage operation.
  reverseMessage(message: PeerMessage) {
    switch (message.type) {
      case "created":
        if (!isSerializedSyncNode(message.node)) {
          console.error(
            `Node is of unknown type: ${JSON.stringify(message.node)}`,
          );
          return;
        }
        const nodeToDestroy = this.getNodeBySyncId(message.node.$.syncId);
        if (!nodeToDestroy) {
          console.error(
            "Attempted to reverse create operation but node does not exist",
          );
          return;
        }
        this.syncIdToNodeKey.delete(message.node.$.syncId);
        nodeToDestroy.remove();
        break;
      case "updated":
        if (!isSerializedSyncNode(message.node)) {
          console.error(
            `Node is of unknown type: ${JSON.stringify(message.node)}`,
          );
          return;
        }
        const nodeToUpdate = this.getNodeBySyncId(message.node.$.syncId);
        if (nodeToUpdate) {
          nodeToUpdate.updateFromJSON(message.previousNode);
          return;
        }
        break;
      case "destroyed":
        this.syncIdToNodeKey.delete(message.node.$.syncId);
        this.createNodeFromMessage(message);
        break;
      case "cursor":
        // no-op, although moving our own cursor back in time might be cool
        break;
      default:
        console.error(`Unknown message type: ${JSON.stringify(message)}`);
        return;
    }
  }

  // Creates a node for a peer message.
  // @todo How can we generically support all node types?
  createNodeFromMessage(message: NodeMessageBase) {
    let messageNode;
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
        console.error(`Previous key not found: ${message.previousId}`);
        return;
      }
      previousNode.insertAfter(messageNode);
      this.mapSyncIdToNodeKey(message.node.$.syncId, messageNode.getKey());
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
      this.mapSyncIdToNodeKey(message.node.$.syncId, messageNode.getKey());
    } else {
      if (messageNode.getType() === "text") {
        console.error("text nodes cannot be appended to root");
        return;
      }
      $getRoot().append(messageNode);
      this.mapSyncIdToNodeKey(message.node.$.syncId, messageNode.getKey());
    }
  }

  // Support undo by undoing our previous sends to the server.
  // @todo This doesn't work (well?) when offline editing
  undoCommand() {
    const lastStack = this.undoStack.pop();
    if (!lastStack) {
      return true;
    }
    this.redoStack.push(lastStack);
    this.undoCommandRunning = true;
    this.editor.update(
      () => {
        lastStack.forEach((m) => this.reverseMessage(m));
      },
      { tag: SKIP_DOM_SELECTION_TAG },
    );
    return true;
  }

  // Support redo by attempting to re-apply the last undo'd stack.
  redoCommand() {
    const lastStack = this.redoStack.pop();
    if (!lastStack) {
      return true;
    }
    this.undoStack.push(lastStack);
    this.undoCommandRunning = true;
    this.editor.update(
      () => {
        lastStack.forEach((m) => this.applyMessage(m));
      },
      { tag: SKIP_DOM_SELECTION_TAG },
    );
    return true;
  }

  // Persists our editor state if possible.
  // @todo all clients don't _need_ to do this, but doesn't seem too harmful
  // and the server could use this to track desyncs between clients on the
  // same stream ID (lastId).
  persist() {
    if (
      this.ws &&
      this.ws.readyState === this.ws.OPEN &&
      this.lastId &&
      (!this.lastPersistedId || this.lastId !== this.lastPersistedId)
    ) {
      this.lastPersistedId = this.lastId;
      this.send({
        type: "persist-document",
        lastId: this.lastId,
        editorState: this.editor.getEditorState().toJSON(),
      });
    }
  }

  // Sends our local cursor position to peers.
  sendCursor() {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) {
      return;
    }
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

  // Removes peer cursors if left inactive.
  cleanupInactiveCursors() {
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
  }

  // Debug utilities to test offline syncing.
  debugDisconnect() {
    this.shouldReconnect = false;
    this.ws?.close();
  }

  debugReconnect() {
    this.shouldReconnect = true;
  }
}
