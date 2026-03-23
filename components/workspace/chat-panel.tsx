"use client";

import { useChat } from "ai/react";
import { ChevronLeft, MessageSquareText, SendHorizonal } from "lucide-react";
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
        "relative border-l border-black/10 bg-[#13191f] text-white transition-all duration-300",
        isOpen ? "w-full md:w-[420px]" : "w-16"
      )}
    >
      <button
        className="absolute left-3 top-3 z-10 rounded-full border border-white/15 bg-white/5 p-2 text-white"
        onClick={onToggle}
        type="button"
      >
        <ChevronLeft className={cn("h-4 w-4 transition", !isOpen && "rotate-180")} />
      </button>

      {isOpen ? (
        <div className="flex h-screen flex-col">
          <div className="border-b border-white/10 px-6 pb-5 pt-16">
            <p className="text-xs uppercase tracking-[0.28em] text-white/40">Inquiry</p>
            <h2 className="mt-3 text-2xl font-semibold leading-tight">{paperTitle}</h2>
            <div className="mt-5 flex flex-wrap gap-2">
              {starterQuestions.map((question) => (
                <button
                  key={question}
                  className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-left text-xs leading-5 text-white/80 transition hover:bg-white/10"
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
          </div>

          <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
            {messages.length === 0 ? (
              <div className="rounded-3xl border border-dashed border-white/15 bg-white/5 p-5 text-sm leading-7 text-white/65">
                Ask about contributions, methodology, assumptions, limitations, or any term that needs explanation.
              </div>
            ) : null}
            {messages.map((message) => (
              <div
                key={message.id}
                className={cn(
                  "rounded-3xl px-4 py-3 text-sm leading-7",
                  message.role === "user" ? "ml-8 bg-white text-night" : "mr-8 bg-white/8 text-white/90"
                )}
              >
                {message.content}
              </div>
            ))}
            {status === "streaming" ? (
              <div className="mr-8 flex items-center gap-3 rounded-3xl bg-white/8 px-4 py-3 text-sm text-white/70">
                <MessageSquareText className="h-4 w-4" />
                OpenAI is responding...
              </div>
            ) : null}
          </div>

          <form className="border-t border-white/10 p-4" onSubmit={handleSubmit}>
            <div className="flex gap-3 rounded-[1.5rem] border border-white/10 bg-white/5 p-3">
              <textarea
                className="min-h-24 flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-white/35"
                placeholder="Ask a question about this paper"
                value={input}
                onChange={handleInputChange}
              />
              <button className="self-end rounded-full bg-coral p-3 text-white" type="submit">
                <SendHorizonal className="h-4 w-4" />
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </aside>
  );
}
