// Where each item sits in a Realtime conversation (SEC-A005 R2). Items are
// numbered as the server adds them (conversation.item.added / .created),
// which is the conversation's order; a transcript arrives whenever it is
// ready, so its arrival is not. A yes to a proposal on a call is judged by
// these numbers (lib/secretary/proposals.ts). An item put anywhere but at
// the end gets no number: its place is unknown, and the server never
// guesses.
export class ItemOrder {
  private numbers = new Map<string, number>();
  private seen = new Set<string>();
  private last: string | null = null;
  private next = 0;

  /** Record an item-added event. */
  add(event: Record<string, unknown>): void {
    const id = (event.item as { id?: unknown } | undefined)?.id;
    if (typeof id !== "string" || this.seen.has(id)) return;
    this.seen.add(id);
    // At the end: after the last item, or after one from before this client
    // was listening. After any other item seen here, it was put in between.
    const previous = event.previous_item_id;
    const atEnd = typeof previous !== "string" || previous === this.last || !this.seen.has(previous);
    if (!atEnd) return;
    this.last = id;
    this.numbers.set(id, ++this.next);
  }

  /** An item's number, or undefined when its place is unknown. */
  numberOf(itemId: unknown): number | undefined {
    return typeof itemId === "string" ? this.numbers.get(itemId) : undefined;
  }
}
