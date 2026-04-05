"use client";

import { useChat } from "ai/react";
import { ChevronLeft } from "lucide-react";
import { KeyboardEvent, useEffect, useRef, useState } from "react";
import { RichText } from "@/components/rich-text";
import type { ChatMessage } from "@/lib/types";
import { cn } from "@/lib/utils";

type Props = {
  paperId: string;
  paperTitle: string;
  starterQuestions: string[];
  initialMessages: ChatMessage[];
  isOpen: boolean;
  onToggle: () => void;
};

export function ChatPanel({
  paperId,
  paperTitle,
  starterQuestions,
  initialMessages,
  isOpen,
  onToggle
}: Props) {
  const [animatedMessageIds, setAnimatedMessageIds] = useState<string[]>([]);
  const seenMessageIdsRef = useRef<Set<string>>(new Set());
  const { messages, input, handleInputChange, handleSubmit, append, setMessages, status } = useChat({
    api: "/api/chat",
    body: {
      paperId
    },
    initialMessages: initialMessages.map((message) => ({
      id: crypto.randomUUID(),
      role: message.role,
      content: message.content
    }))
  });

  useEffect(() => {
    setMessages(
      initialMessages.map((message) => ({
        id: crypto.randomUUID(),
        role: message.role,
        content: message.content
      }))
    );
  }, [initialMessages, setMessages]);

  useEffect(() => {
    seenMessageIdsRef.current = new Set(messages.map((message) => message.id));
  }, [initialMessages]);

  useEffect(() => {
    const newMessageIds = messages
      .map((message) => message.id)
      .filter((id) => !seenMessageIdsRef.current.has(id));

    if (newMessageIds.length === 0) {
      return;
    }

    newMessageIds.forEach((id) => seenMessageIdsRef.current.add(id));
    setAnimatedMessageIds((current) => [...current, ...newMessageIds]);

    const timeoutId = window.setTimeout(() => {
      setAnimatedMessageIds((current) => current.filter((id) => !newMessageIds.includes(id)));
    }, 420);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [messages]);

  const latestMessage = messages[messages.length - 1];
  const isAwaitingVisibleResponse =
    (status === "submitted" || status === "streaming") &&
    (latestMessage?.role !== "assistant" || !latestMessage.content.trim());
  const isResponding = status === "submitted" || status === "streaming";
  const canSend = input.trim().length > 0 && !isResponding;

  function onTextareaKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }

    event.preventDefault();

    if (!canSend) {
      return;
    }

    handleSubmit();
  }

  return (
    <aside
      className={cn(
        "relative h-full min-h-0 shrink-0 overflow-hidden border-l border-rim bg-pit text-linen transition-all duration-300",
        isOpen ? "w-full md:w-[420px]" : "w-14"
      )}
    >
      {/* Toggle button */}
      <button
        className="absolute left-3 top-3 z-10 rounded border border-rim bg-cave p-2 text-smoke transition hover:border-gold/40 hover:text-gold"
        onClick={onToggle}
        type="button"
        aria-label={isOpen ? "Close inquiry panel" : "Open inquiry panel"}
      >
        <ChevronLeft className={cn("h-4 w-4 transition-transform duration-300", !isOpen && "rotate-180")} />
      </button>

      {isOpen ? (
        <div className="flex h-full min-h-0 flex-col">
          {/* Header */}
          <div className="border-b border-rim px-5 pb-5 pt-14">
            <p className="font-mono text-[10px] uppercase tracking-[0.44em] text-gold/80">Inquiry</p>
            <h2 className="mt-2 font-display text-xl font-light leading-snug text-linen">
              {paperTitle}
            </h2>

            {/* Starter questions */}
            {starterQuestions.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-1.5">
                {starterQuestions.map((question) => (
                  <button
                    key={question}
                    className="rounded border border-rim/90 bg-gradient-to-br from-cave via-cave to-shell/70 px-2.5 py-1.5 text-left font-mono text-[11px] leading-[1.5] text-fog ring-1 ring-white/5 transition hover:border-gold/35 hover:text-linen"
                    onClick={() =>
                      append({
                        role: "user",
                        content: question
                      })
                    }
                    type="button"
                  >
                    {question}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Messages */}
          <div className="flex-1 space-y-3 overflow-y-auto px-5 py-5">
            {messages.length === 0 ? (
              <div className="rounded-lg border border-dashed border-rim p-4 font-mono text-[11px] leading-[1.8] text-fog">
                Ask about contributions, methodology, assumptions, limitations, or any term that needs unpacking.
              </div>
            ) : null}

            {messages.map((message) => (
              <div
                key={message.id}
                className={cn(
                  "rounded-lg px-4 py-3 font-mono text-[12px] leading-[1.75]",
                  animatedMessageIds.includes(message.id) && "chat-message-enter",
                  message.role === "user"
                    ? "ml-6 border-l-2 border-gold bg-shell text-linen"
                    : "mr-6 bg-cave text-smoke"
                )}
              >
                {message.role === "assistant" ? (
                  <RichText content={message.content} className="font-mono text-[12px] leading-[1.75] text-smoke" />
                ) : (
                  message.content
                )}
              </div>
            ))}

            {isAwaitingVisibleResponse ? (
              <div
                aria-live="polite"
                className="chat-thinking-enter mr-6 flex items-center gap-2 rounded-lg border border-rim/70 bg-cave px-4 py-3"
              >
                <div className="flex items-center gap-1">
                  <span className="chat-thinking-dot h-1.5 w-1.5 rounded-full bg-gold/70" />
                  <span
                    className="chat-thinking-dot h-1.5 w-1.5 rounded-full bg-gold/70"
                    style={{ animationDelay: "120ms" }}
                  />
                  <span
                    className="chat-thinking-dot h-1.5 w-1.5 rounded-full bg-gold/70"
                    style={{ animationDelay: "240ms" }}
                  />
                </div>
                <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-gold/70">
                  Awaiting response...
                </span>
              </div>
            ) : null}
          </div>

          {/* Input */}
          <form className="border-t border-rim p-4" onSubmit={handleSubmit}>
            <div
              className={cn(
                "flex gap-2 rounded-lg border border-rim bg-cave p-3 transition focus-within:border-gold/40",
                isResponding && "shadow-[0_0_0_1px_rgba(232,160,48,0.22),0_0_24px_rgba(232,160,48,0.08)]"
              )}
            >
              <span className="select-none self-start pt-0.5 font-mono text-[13px] text-gold/50">›</span>
              <textarea
                className="min-h-20 flex-1 resize-none bg-transparent font-mono text-[12px] text-linen outline-none placeholder:text-fog"
                placeholder="Ask anything about this paper..."
                value={input}
                onChange={handleInputChange}
                onKeyDown={onTextareaKeyDown}
              />
              <button
                className={cn(
                  "self-end rounded px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.24em] transition",
                  canSend
                    ? "bg-gold text-void hover:bg-gold/90 active:scale-95"
                    : "bg-gold/80 text-void"
                )}
                disabled={!canSend}
                type="submit"
              >
                <span className={cn("inline-flex items-center gap-2", isResponding && "translate-y-[1px]")}>
                  <span>{isResponding ? "Sending" : "Send"}</span>
                  <span
                    className={cn(
                      "inline-block transition-transform duration-200",
                      isResponding ? "chat-send-flight" : "translate-x-0"
                    )}
                  >
                    →
                  </span>
                </span>
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </aside>
  );
}
