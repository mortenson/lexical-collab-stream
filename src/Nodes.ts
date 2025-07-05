import { $create, $setState, createState, ParagraphNode, TextNode } from "lexical";
import { v7 as uuidv7 } from 'uuid';

const SYNC_ID_UNSET = 'SYNC_ID_UNSET'

const syncIdState = createState('syncId', {
  parse: (v) => (typeof v === 'string' ? v : SYNC_ID_UNSET),
});

export class SyncTextNode extends TextNode {
  $config() {
    return this.config('sync-text', {
      extends: TextNode,
      stateConfigs: [{flat: true, stateConfig: syncIdState}],
    });
  }

  splitText(...splitOffsets: Array<number>): Array<TextNode> {
    const splitNodes = super.splitText(...splitOffsets)
    splitNodes.forEach(node => {
      $setState(node, syncIdState, uuidv7());
    })
    return splitNodes;
  }
}

export function $createSyncTextNode(text: string): SyncTextNode {
  return $setState($create(SyncTextNode).setTextContent(text).getWritable(), syncIdState, uuidv7());
}

export class SyncParagraphNode extends ParagraphNode {
  $config() {
    return this.config('sync-paragraph', {
      extends: ParagraphNode,
      stateConfigs: [{flat: true, stateConfig: syncIdState}],
    });
  }
}

export function $createSyncParagraphNode(): SyncParagraphNode {
  return $setState($create(SyncParagraphNode), syncIdState, uuidv7());
}
