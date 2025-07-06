# Lexical Sync Demo (without Yjs)

After reading the article "[Collaborative Text Editing without CRDTs or OT](https://mattweidner.com/2025/05/21/text-without-crdts.html)",
I thought that it's be fun to try to build a collaborative editor without Yjs.

Here's how it works:

1. The paragraph and text nodes are overridden and contain UUIDs in NodeState
2. A mapping is (poorly?) maintained between UUIDs and NodeKeys
3. A custom Node Transform is used to (try to) split TextNodes by word (more
nodes == better sync, probably)
4. Clients connect to a websocket server and receive the current EditorState 
5. A mutation listener sends websocket messages that contain a serialized node
and information required to upsert/destroy it
6. A websocket listener receives messages from other clients and upserts nodes
from JSON, or destroys them. Node insertion is always relative to a sibling or
parent.

## Running locally

1. In one tab: `npm i && npm run dev`
2. In another tab: `node server.ts` (requires Node v22.6.0+, too lazy to transpile)

## Credit

This repository is cloned from `@lexical/react-rich-example`,
`src/plugins/CollaborationPlugin.tsx`, `src/Nodes.ts`, `src/Messages.ts`, and
`server.ts` are the unique code for the demo.
