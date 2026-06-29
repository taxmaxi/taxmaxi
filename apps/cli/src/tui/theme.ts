/**
 * TaxMaxi terminal palettes.
 *
 * The dark palette mirrors the marketing surface. The light palette follows
 * the auth surface in taxmaxi.com: warm paper, deep green text, muted green
 * secondary text, and tan dividers.
 */
import { CliRenderEvents } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { createEffect, createSignal, onCleanup, type JSX } from "solid-js"

export type ThemeMode = "dark" | "light"

export type TaxMaxiTheme = Readonly<{
  background: string
  backgroundPanel: string
  backgroundElement: string
  border: string
  textMuted: string
  textSecondary: string
  textSoft: string
  text: string
  textCream: string
  accent: string
  success: string
  warning: string
  error: string
}>

export const taxmaxiThemes: Readonly<Record<ThemeMode, TaxMaxiTheme>> = {
  dark: {
    background: "#0d1210",
    backgroundPanel: "#111d18",
    backgroundElement: "#151a18",
    border: "#2a3a35",
    textMuted: "#6b9484",
    textSecondary: "#8ab4a3",
    textSoft: "#a3c4b5",
    text: "#e8f5ee",
    textCream: "#f7f0e3",
    accent: "#34d399",
    success: "#10b981",
    warning: "#e8c468",
    error: "#e87a6d",
  },
  light: {
    background: "#f5f2e8",
    backgroundPanel: "#ffffff",
    backgroundElement: "#ebe5d8",
    border: "#d9d2bc",
    textMuted: "#5f7f72",
    textSecondary: "#2a6857",
    textSoft: "#1e4d40",
    text: "#14382f",
    textCream: "#1e4d40",
    accent: "#1e4d40",
    success: "#1a7f37",
    warning: "#9a6700",
    error: "#cf222e",
  },
}

const [currentTheme, setCurrentTheme] = createSignal<TaxMaxiTheme>(taxmaxiThemes.dark)
const [currentMode, setCurrentMode] = createSignal<ThemeMode>("dark")
const [lockedMode, setLockedMode] = createSignal<ThemeMode | undefined>(undefined)

const pickMode = (value: unknown): ThemeMode => (value === "light" ? "light" : "dark")

const setThemeMode = (mode: ThemeMode) => {
  setCurrentMode(mode)
  setCurrentTheme(taxmaxiThemes[mode])
}

export function setThemeModeLock(mode: ThemeMode): void {
  setLockedMode(mode)
  setThemeMode(mode)
}

export function clearThemeModeLock(): void {
  setLockedMode(undefined)
}

export const theme: TaxMaxiTheme = new Proxy(taxmaxiThemes.dark, {
  get(target, property, receiver) {
    if (typeof property === "string" && property in target) {
      return currentTheme()[property as keyof TaxMaxiTheme]
    }
    return Reflect.get(target, property, receiver)
  },
})

export function useTheme(): TaxMaxiTheme {
  return theme
}

export function useThemeMode(): ThemeMode {
  return currentMode()
}

export function useThemeModeLocked(): boolean {
  return lockedMode() !== undefined
}

export function ThemeProvider(props: { readonly children: JSX.Element }): JSX.Element {
  const renderer = useRenderer()
  setThemeMode(pickMode(renderer.themeMode))

  const handleThemeMode = (mode: ThemeMode) => {
    if (lockedMode() === undefined) {
      setThemeMode(mode)
    }
  }
  renderer.on(CliRenderEvents.THEME_MODE, handleThemeMode)

  createEffect(() => {
    renderer.setBackgroundColor(currentTheme().background)
  })

  onCleanup(() => {
    renderer.off(CliRenderEvents.THEME_MODE, handleThemeMode)
  })

  return props.children
}
