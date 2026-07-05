import { useCallback, useState } from "react"
import { toast } from "sonner"

function fallbackCopy(text: string): boolean {
  const textarea = document.createElement("textarea")
  textarea.value = text
  textarea.setAttribute("readonly", "")
  textarea.style.position = "fixed"
  textarea.style.left = "-9999px"
  textarea.style.opacity = "0"
  document.body.appendChild(textarea)

  const selection = document.getSelection()
  const previousRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null

  textarea.select()
  textarea.setSelectionRange(0, text.length)

  let success = false
  try {
    success = document.execCommand("copy")
  } catch {
    success = false
  }

  document.body.removeChild(textarea)
  if (previousRange && selection) {
    selection.removeAllRanges()
    selection.addRange(previousRange)
  }

  return success
}

export default function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    let success = false
    try {
      await navigator.clipboard.writeText(text)
      success = true
    } catch {
      success = fallbackCopy(text)
    }

    if (success) {
      setCopied(true)
      toast.success("Copied to clipboard", {
        duration: 1500,
        position: "top-center",
        className:
          "!bg-[#1a1f1d] !border-[#8ab4a3]/30 !text-[#a3c4b5] !shadow-lg !shadow-black/30 !font-mono",
      })
      setTimeout(() => setCopied(false), 1500)
    }
  }, [text])

  return (
    <button
      type="button"
      aria-label={copied ? "Copied to clipboard" : "Copy command to clipboard"}
      onClick={handleCopy}
      className="cursor-pointer rounded-md p-1.5 text-[#8ab4a3]/40 transition-colors hover:bg-[#8ab4a3]/10 hover:text-[#8ab4a3]"
    >
      {copied ? (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  )
}
