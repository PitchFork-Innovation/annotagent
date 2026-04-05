"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import type { PaperWorkspace } from "@/lib/types";
import { ChatPanel } from "./chat-panel";

const PdfWorkspace = dynamic(
  () => import("./pdf-workspace").then((module) => module.PdfWorkspace),
  {
    ssr: false,
    loading: () => (
      <div className="flex min-h-screen items-center justify-center bg-void font-mono text-[13px] text-smoke">
        <span className="cursor-blink">Loading workspace</span>
      </div>
    )
  }
);

export function AnnotationWorkspace({ workspace }: { workspace: PaperWorkspace }) {
  const [isChatOpen, setIsChatOpen] = useState(false);

  return (
    <main className="h-screen overflow-hidden bg-void text-linen">
      <div className="flex h-full min-h-0">
        <div className="min-w-0 flex-1 overflow-y-auto">
          <PdfWorkspace workspace={workspace} onToggleChat={() => setIsChatOpen((value) => !value)} />
        </div>
        <ChatPanel
          isOpen={isChatOpen}
          onToggle={() => setIsChatOpen((value) => !value)}
          paperId={workspace.paper.id}
          paperTitle={workspace.paper.title}
          starterQuestions={workspace.paper.starterQuestions}
          initialMessages={workspace.chatHistory}
        />
      </div>
    </main>
  );
}
