import {
  $create,
  $setState,
  createState,
  LexicalUpdateJSON,
  ParagraphNode,
  SerializedElementNode,
  SerializedParagraphNode,
  SerializedTextNode,
  TextNode,
} from "lexical";
import { v7 as uuidv7 } from "uuid";

export const SYNC_ID_UNSET = "SYNC_ID_UNSET";

export const syncIdState = createState("syncId", {
  parse: (v) => (typeof v === "string" ? v : SYNC_ID_UNSET),
});

export class SyncTextNode extends TextNode {
  $config() {
    return this.config("sync-text", {
      extends: TextNode,
      stateConfigs: [{ flat: true, stateConfig: syncIdState }],
    });
  }

  splitText(...splitOffsets: Array<number>): Array<TextNode> {
    const splitNodes = super.splitText(...splitOffsets);
    splitNodes.forEach((node, i) => {
      if (i === 0) {
        return;
      }
      $setState(node, syncIdState, uuidv7());
    });
    return splitNodes;
  }

  updateFromJSON(
    serializedNode: LexicalUpdateJSON<SerializedSyncTextNode>,
  ): this {
    return $setState(
      super.updateFromJSON(serializedNode),
      syncIdState,
      serializedNode.syncId,
    );
  }
}

export interface SerializedSyncTextNode extends SerializedTextNode {
  syncId: string;
}

export function $createSyncTextNode(text?: string): SyncTextNode {
  const node = $create(SyncTextNode);
  if (text) {
    node.setTextContent(text);
  }
  return $setState(node.getWritable(), syncIdState, uuidv7());
}

export class SyncParagraphNode extends ParagraphNode {
  $config() {
    return this.config("sync-paragraph", {
      extends: ParagraphNode,
      stateConfigs: [{ flat: true, stateConfig: syncIdState }],
    });
  }

  updateFromJSON(
    serializedNode: LexicalUpdateJSON<SerializedSyncParagraphNode>,
  ): this {
    return $setState(
      super.updateFromJSON(serializedNode),
      syncIdState,
      serializedNode.syncId,
    );
  }
}

export interface SerializedSyncParagraphNode extends SerializedParagraphNode {
  syncId: string;
}

export function $createSyncParagraphNode(): SyncParagraphNode {
  return $setState($create(SyncParagraphNode), syncIdState, uuidv7());
}
