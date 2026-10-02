import { EventEmitter } from "node:events";

export interface PanelEvent {
  type: "message" | "conversation" | "outbox";
  conversationId: number;
}

/** Bus en proceso: el cerebro avisa y el panel (SSE) refresca lo que está viendo. */
export class EventBus {
  private readonly em = new EventEmitter();

  constructor() {
    this.em.setMaxListeners(100);
  }

  emit(event: PanelEvent): void {
    this.em.emit("event", event);
  }

  subscribe(fn: (event: PanelEvent) => void): () => void {
    this.em.on("event", fn);
    return () => this.em.off("event", fn);
  }
}
