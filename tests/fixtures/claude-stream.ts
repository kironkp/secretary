// A fake Claude's streamed call, built on its whole one. The chat streams
// since v1.09 (docs/chat/SPEC.md §1): `messages.stream` gives the answer's
// text as it is written ("text" events), then the whole message. A fake that
// answers whole gets the same answer through this, its text in one piece.
type Answer = { content: { type: string; text?: string }[] };
type TextListener = (delta: string, snapshot: string) => void;

export function streamedFrom<P>(create: (params: P) => Promise<Answer>) {
  return (params: P) => {
    const listeners: TextListener[] = [];
    // Sent when the stream is opened, as the SDK does; read when the caller asks for the message.
    const sent = create(params);
    sent.catch(() => {});
    return {
      on(event: string, listener: TextListener) {
        if (event === "text") listeners.push(listener);
        return this;
      },
      async finalMessage() {
        const message = await sent;
        let snapshot = "";
        for (const block of message.content) {
          if (block.type !== "text" || !block.text) continue;
          snapshot += block.text;
          for (const l of listeners) l(block.text, snapshot);
        }
        return message;
      },
    };
  };
}
