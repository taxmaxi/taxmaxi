import CopyButton from "./copy-button"
import { cn } from "#/lib/utils"

export function Terminal({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-[#2a3a35] bg-[#0d1210] shadow-2xl shadow-black/40 overflow-hidden",
        className
      )}
    >
      {/* Title bar */}
      <div className="flex items-center gap-2 px-4 py-3 bg-[#151a18] border-b border-[#2a3a35]">
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-full bg-[#ff5f57]" />
          <div className="w-3 h-3 rounded-full bg-[#febc2e]" />
          <div className="w-3 h-3 rounded-full bg-[#28c840]" />
        </div>
      </div>
      {/* Terminal body */}
      {children}
    </div>
  )
}

export function TerminalComment({ comment }: { comment: string }) {
  return <p className="text-[#8ab4a3]/40">{comment}</p>
}

export function TerminalCommand({ command }: { command: string | string[] }) {
  const lines = Array.isArray(command) ? command : [command]
  const copyText = lines.join("\n")

  return (
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        {lines.map((line, i) => (
          <p key={i}>
            {i === 0 ? (
              <>
                <span className="text-[#28c840]">$</span>{" "}
                <span className="text-[#a3c4b5]">{line}</span>
              </>
            ) : (
              <span className="text-[#a3c4b5]">{line}</span>
            )}
          </p>
        ))}
      </div>
      <CopyButton text={copyText} />
    </div>
  )
}

export function TerminalOutput({ children }: { children: React.ReactNode }) {
  return <p className="text-[#9ac6ff]">{children}</p>
}
