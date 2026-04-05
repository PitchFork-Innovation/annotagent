"use client";

import { useChat } from "ai/react";
import { ChevronLeft } from "lucide-react";
import { useEffect } from "react";
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

  return (
    <aside
      className={cn(
        "relative border-l border-rim bg-pit text-linen transition-all duration-300",
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
        <div className="flex h-screen flex-col">
          {/* Header */}
          <div className="border-b border-rim px-5 pb-5 pt-14">
            <p className="font-mono text-[10px] uppercase tracking-[0.44em] text-smoke">Inquiry</p>
            <h2 className="mt-2 font-display text-xl font-light leading-snug text-linen">
              {paperTitle}
            </h2>

            {/* Starter questions */}
            {starterQuestions.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-1.5">
                {starterQuestions.map((question) => (
                  <button
                    key={question}
                    className="rounded border border-rim bg-shell/50 px-2.5 py-1.5 text-left font-mono text-[11px] leading-[1.5] text-smoke transition hover:border-gold/40 hover:bg-shell hover:text-linen"
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
                  message.role === "user"
                    ? "ml-6 border-l-2 border-gold bg-shell text-linen"
                    : "mr-6 bg-cave text-smoke"
                )}
              >
                {message.content}
              </div>
            ))}

            {status === "streaming" ? (
              <div className="mr-6 flex items-center gap-2 rounded-lg bg-cave px-4 py-3">
                <span className="cursor-blink font-mono text-[11px] text-gold/60">generating</span>
              </div>
            ) : null}
          </div>

          {/* Input */}
          <form className="border-t border-rim p-4" onSubmit={handleSubmit}>
            <div className="flex gap-2 rounded-lg border border-rim bg-cave p-3 transition focus-within:border-gold/40">
              <span className="select-none self-start pt-0.5 font-mono text-[13px] text-gold/50">›</span>
              <textarea
                className="min-h-20 flex-1 resize-none bg-transparent font-mono text-[12px] text-linen outline-none placeholder:text-fog"
                placeholder="Ask anything about this paper..."
                value={input}
                onChange={handleInputChange}
              />
              <button
                className="self-end rounded bg-gold px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.24em] text-void transition hover:bg-gold/90 active:scale-95"
                type="submit"
              >
                Send
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </aside>
  );
}
