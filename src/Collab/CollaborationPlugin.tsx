import { useEffect, useMemo, useRef, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { CollabCursor, CollabInstance } from "./Collab";

export default function CollaborationPlugin() {
  const [editor] = useLexicalComposerContext();
  const [cursors, setCursors] = useState<Map<string, CollabCursor>>();
  const [connected, setConnected] = useState(true);
  const collab = useRef<CollabInstance>();
  useEffect(() => {
    editor.setEditable(false);
    const userId = "user_" + Math.floor(Math.random() * 100);
    collab.current = new CollabInstance(userId, editor, (cursors) => {
      setCursors(new Map(cursors));
    });
    collab.current.start();
    return () => collab.current?.stop();
  }, [editor]);
  return (
    <>
      <button
        onClick={() => {
          if (connected) {
            collab.current?.debugDisconnect();
          } else {
            collab.current?.debugReconnect();
          }
          setConnected(!connected);
        }}
      >
        {connected ? "Disconnect" : "Connect"}
      </button>
      {cursors &&
        Array.from(cursors.entries()).map(([userId, cursor]) => {
          return <CursorElement userId={userId} cursor={cursor} key={userId} />;
        })}
    </>
  );
}

type CursorElementProps = {
  userId: string;
  cursor: CollabCursor;
};

const CursorElement = ({ userId, cursor }: CursorElementProps) => {
  const rect: DOMRect | void = useMemo(() => {
    try {
      if (
        !cursor.anchorElement.firstChild ||
        cursor.anchorElement.firstChild.nodeType !==
          cursor.anchorElement.firstChild.TEXT_NODE
      ) {
        return;
      }
      if (
        !cursor.focusElement.firstChild ||
        cursor.focusElement.firstChild.nodeType !==
          cursor.focusElement.firstChild.TEXT_NODE
      ) {
        return;
      }
      const range = document.createRange();
      if (
        cursor.anchorElement.compareDocumentPosition(cursor.focusElement) === 2
      ) {
        range.setEnd(cursor.anchorElement.firstChild, cursor.anchorOffset);
        range.setStart(cursor.focusElement.firstChild, cursor.focusOffset);
      } else {
        range.setStart(cursor.anchorElement.firstChild, cursor.anchorOffset);
        range.setEnd(cursor.focusElement.firstChild, cursor.focusOffset);
      }
      return range.getBoundingClientRect();
    } catch (_) {}
  }, [cursor]);
  if (!rect) {
    return <></>;
  }
  return (
    <div
      className="collab-cursor"
      style={{
        left: `${rect.x + window.scrollX}px`,
        top: `${rect.y + window.scrollY}px`,
        width: `${rect.width > 2 ? rect.width : 2}px`,
        height: `${rect.height}px`,
      }}
    >
      <div
        className="collab-cursor-user"
        style={{ top: `${-1 * rect.height - 2}px` }}
      >
        {userId}
      </div>
    </div>
  );
};
