import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import { cn } from "@/lib/utils";

type Props = {
  content: string;
  className?: string;
};

export function RichText({ content, className }: Props) {
  return (
    <div className={cn("rich-text space-y-3 text-sm leading-7 text-inherit", className)}>
      <ReactMarkdown
        rehypePlugins={[rehypeKatex]}
        remarkPlugins={[remarkMath]}
        components={{
          p: ({ className: nodeClassName, ...props }) => <p className={cn("m-0", nodeClassName)} {...props} />,
          ul: ({ className: nodeClassName, ...props }) => (
            <ul className={cn("m-0 list-disc space-y-2 pl-5", nodeClassName)} {...props} />
          ),
          ol: ({ className: nodeClassName, ...props }) => (
            <ol className={cn("m-0 list-decimal space-y-2 pl-5", nodeClassName)} {...props} />
          ),
          li: ({ className: nodeClassName, ...props }) => <li className={cn("pl-1", nodeClassName)} {...props} />,
          strong: ({ className: nodeClassName, ...props }) => (
            <strong className={cn("font-semibold text-current", nodeClassName)} {...props} />
          ),
          code: ({ className: nodeClassName, ...props }) => (
            <code
              className={cn("rounded bg-black/10 px-1 py-0.5 text-[0.95em] text-current", nodeClassName)}
              {...props}
            />
          )
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
