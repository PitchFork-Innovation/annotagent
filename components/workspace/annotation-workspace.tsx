"use client";

import { useState } from "react";
import type { PaperWorkspace } from "@/lib/types";
import { ChatPanel } from "./chat-panel";
import { PdfWorkspace } from "./pdf-workspace";

export function AnnotationWorkspace({ workspace }: { workspace: PaperWorkspace }) {
  const [isChatOpen, setIsChatOpen] = useState(true);

  return (
    <main className="min-h-screen bg-[#efe7d7] text-night">
      <div className="flex min-h-screen">
        <div className="min-w-0 flex-1">
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
