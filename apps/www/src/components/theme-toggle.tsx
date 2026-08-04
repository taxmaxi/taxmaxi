import { Monitor, Moon, Sun } from "lucide-react"
import { useEffect, useState } from "react"

type ThemeMode = "light" | "dark" | "auto"

function getInitialMode(): ThemeMode {
  if (typeof window === "undefined") {
    return "auto"
  }

  const stored = window.localStorage.getItem("theme")
  if (stored === "light" || stored === "dark" || stored === "auto") {
    return stored
  }

  return "auto"
}

function applyThemeMode(mode: ThemeMode) {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches
  const resolved = mode === "auto" ? (prefersDark ? "dark" : "light") : mode

  document.documentElement.classList.remove("light", "dark")
  document.documentElement.classList.add(resolved)

  if (mode === "auto") {
    document.documentElement.removeAttribute("data-theme")
  } else {
    document.documentElement.setAttribute("data-theme", mode)
  }

  document.documentElement.style.colorScheme = resolved
}

export default function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>("auto")
  const nextMode: ThemeMode = mode === "light" ? "dark" : mode === "dark" ? "auto" : "light"

  useEffect(() => {
    const initialMode = getInitialMode()
    setMode(initialMode)
    applyThemeMode(initialMode)
  }, [])

  useEffect(() => {
    if (mode !== "auto") {
      return
    }

    const media = window.matchMedia("(prefers-color-scheme: dark)")
    const onChange = () => applyThemeMode("auto")

    media.addEventListener("change", onChange)
    return () => {
      media.removeEventListener("change", onChange)
    }
  }, [mode])

  function toggleMode() {
    setMode(nextMode)
    applyThemeMode(nextMode)
    window.localStorage.setItem("theme", nextMode)
  }

  const label = `Theme: ${mode}. Switch to ${nextMode}.`

  return (
    <button
      type="button"
      onClick={toggleMode}
      aria-label={label}
      title={label}
      className="group relative grid size-9 touch-manipulation place-items-center rounded-full outline-none before:absolute before:-inset-1 before:content-[''] focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <span
        aria-hidden="true"
        className="relative grid size-9 place-items-center rounded-full border border-border bg-background/75 text-foreground shadow-sm [transition:transform_150ms_cubic-bezier(0.25,0.46,0.45,0.94),color_120ms_ease,background-color_120ms_ease,border-color_120ms_ease] group-active:scale-[0.97] motion-reduce:transform-none motion-reduce:group-active:transform-none [@media(hover:hover)_and_(pointer:fine)]:group-hover:bg-accent"
      >
        <Sun
          className="absolute size-4 scale-[0.82] -rotate-12 opacity-0 [transition:opacity_140ms_ease,transform_160ms_cubic-bezier(0.645,0.045,0.355,1)] data-[active=true]:scale-100 data-[active=true]:rotate-0 data-[active=true]:opacity-100 motion-reduce:transform-none"
          data-active={mode === "light"}
        />
        <Moon
          className="absolute size-4 scale-[0.82] -rotate-12 opacity-0 [transition:opacity_140ms_ease,transform_160ms_cubic-bezier(0.645,0.045,0.355,1)] data-[active=true]:scale-100 data-[active=true]:rotate-0 data-[active=true]:opacity-100 motion-reduce:transform-none"
          data-active={mode === "dark"}
        />
        <Monitor
          className="absolute size-4 scale-[0.82] -rotate-12 opacity-0 [transition:opacity_140ms_ease,transform_160ms_cubic-bezier(0.645,0.045,0.355,1)] data-[active=true]:scale-100 data-[active=true]:rotate-0 data-[active=true]:opacity-100 motion-reduce:transform-none"
          data-active={mode === "auto"}
        />
      </span>
    </button>
  )
}
