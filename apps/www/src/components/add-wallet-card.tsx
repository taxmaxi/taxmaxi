import * as React from "react"
import { useEffect, useRef, useState } from "react"
import { ArrowRight, Loader2, Plus } from "lucide-react"

import { m } from "#/paraglide/messages"
import { cn } from "#/lib/utils"
import {
  parseResolveErrorCode,
  parseWalletInput,
  type ResolveErrorCode,
  type WalletChain,
} from "#/lib/wallet-input"

import { getSourceCardStyle, SourceCardChip, SourceCardShell, type Source } from "./source-card"

/**
 * Empty slot in the source fan that turns into a wallet card as the user
 * types. It renders the same card chrome as real source cards; only the
 * bottom row differs, carrying the address form instead of the card number.
 * Chain detection drives the styling: a valid Solana or EVM address restyles
 * the card with that chain's brand colors before submit, and wallet names
 * (ENS, SNS) morph to their chain's styling while the address resolves.
 */

const NAME_RESOLVE_DEBOUNCE_MS = 400

const PREVIEW_SOURCES: Record<WalletChain, Source> = {
  evm: {
    id: "add-wallet-preview-evm",
    name: "",
    kind: "wallet",
    network: "Ethereum",
    importedTransactions: 0,
    unresolvedItems: 0,
    lastSync: "",
  },
  solana: {
    id: "add-wallet-preview-solana",
    name: "",
    kind: "wallet",
    network: "Solana",
    importedTransactions: 0,
    unresolvedItems: 0,
    lastSync: "",
  },
}

export type NameResolution = {
  readonly name: string
  readonly resolvedAddress: string
}

export function AddWalletCard({
  active = false,
  height = "10.75rem",
  onActiveChange,
  onResolveName,
  onSubmit,
  width = "17rem",
}: {
  active?: boolean
  height?: number | string
  onActiveChange?: (active: boolean) => void
  onResolveName?: (name: string) => Promise<NameResolution>
  onSubmit: (walletAddress: string) => Promise<void>
  width?: number | string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const [value, setValue] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [hasSubmitError, setHasSubmitError] = useState(false)
  const [resolution, setResolution] = useState<NameResolution | undefined>()
  const [isResolving, setIsResolving] = useState(false)
  const [resolveError, setResolveError] = useState<ResolveErrorCode | "unknown" | undefined>()

  const parse = parseWalletInput(value)
  const detectedChain = parse.kind === "address" ? parse.chain : undefined
  const nameChain = parse.kind === "name" ? parse.chain : undefined
  const walletName = parse.kind === "name" && onResolveName !== undefined ? parse.name : undefined
  const resolvedForCurrentName = resolution?.name === walletName ? resolution : undefined
  const previewChain = detectedChain ?? (walletName === undefined ? undefined : nameChain)
  const hintChain = previewChain ?? (parse.kind === "partial" ? parse.hint : undefined)
  const previewSource = previewChain === undefined ? undefined : PREVIEW_SOURCES[previewChain]
  const previewStyle = previewSource === undefined ? undefined : getSourceCardStyle(previewSource)
  const hintStyle =
    hintChain === undefined ? undefined : getSourceCardStyle(PREVIEW_SOURCES[hintChain])

  const submitValue =
    parse.kind === "address"
      ? parse.address
      : resolvedForCurrentName === undefined
        ? undefined
        : resolvedForCurrentName.name
  const canSubmit = submitValue !== undefined && !isSubmitting

  const title =
    walletName !== undefined
      ? walletName
      : detectedChain === "evm"
        ? m["app.addWallet.previewNameEvm"]()
        : detectedChain === "solana"
          ? m["app.addWallet.previewNameSolana"]()
          : m["app.addWallet.title"]()

  const { isStatusError, statusText } = getStatusLine({
    detectedChain,
    hasSubmitError,
    isResolving,
    parse,
    resolveError,
    resolvedAddress: resolvedForCurrentName?.resolvedAddress,
    supportsNames: onResolveName !== undefined,
  })

  useEffect(() => {
    if (walletName === undefined || onResolveName === undefined) {
      setIsResolving(false)
      setResolveError(undefined)
      return
    }

    let cancelled = false
    setIsResolving(true)
    setResolveError(undefined)

    const handle = window.setTimeout(() => {
      onResolveName(walletName).then(
        (result) => {
          if (!cancelled) {
            setResolution(result)
            setIsResolving(false)
          }
        },
        (error: unknown) => {
          if (!cancelled) {
            setResolveError(parseResolveErrorCode(error) ?? "unknown")
            setIsResolving(false)
          }
        }
      )
    }, NAME_RESOLVE_DEBOUNCE_MS)

    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [walletName, onResolveName])

  // Resting slots stay empty: a half-typed or morphed ghost card left in the
  // fan would read as an already-added wallet.
  const deactivate = () => {
    setValue("")
    setHasSubmitError(false)
    setResolution(undefined)
    setResolveError(undefined)
    onActiveChange?.(false)
  }

  // Pressing the card chrome must not steal focus from the input: the blur
  // would collapse the card before the click handler runs, and the click
  // would then reopen it. Presses on the input and button keep their
  // native focus behavior.
  const handleCardMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement

    if (target.tagName === "INPUT" || target.closest("button") !== null) {
      return
    }

    event.preventDefault()
  }

  const handleCardClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (formRef.current?.contains(event.target as Node)) {
      return
    }

    // Chrome clicks toggle, matching how a selected source card deselects
    // when clicked again.
    if (active) {
      inputRef.current?.blur()
      deactivate()
      return
    }

    inputRef.current?.focus()
  }

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (submitValue === undefined || isSubmitting) {
      return
    }

    setIsSubmitting(true)
    setHasSubmitError(false)

    try {
      await onSubmit(submitValue)
      deactivate()
      inputRef.current?.blur()
    } catch {
      setHasSubmitError(true)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <SourceCardShell
      className={cn(
        // The dashed edge is an outline, not a border: it paints outside
        // the box like the source cards' ring, so the slot's boundary and
        // content sit exactly where they do on every other card.
        "outline-[1.5px] outline-dashed transition-[background-color,outline-color,box-shadow] duration-200",
        previewStyle ? "outline-transparent" : "bg-card text-muted-foreground outline-foreground/25"
      )}
      height={height}
      onBlur={(event) => {
        if (isSubmitting || event.currentTarget.contains(event.relatedTarget)) {
          return
        }

        deactivate()
      }}
      onClick={handleCardClick}
      onMouseDown={handleCardMouseDown}
      source={previewSource}
      style={previewStyle ? undefined : { outlineColor: hintStyle?.background }}
      width={width}
    >
      <span className="relative z-10 flex items-start justify-between gap-3">
        <span className="min-w-0">
          <span
            className={cn(
              "block truncate text-lg font-semibold tracking-normal",
              previewStyle ? undefined : "text-foreground"
            )}
          >
            {title}
          </span>
          <span
            className={cn(
              "mt-1 block truncate text-xs transition-colors duration-150",
              isStatusError ? "text-destructive" : undefined,
              resolvedForCurrentName === undefined ? undefined : "font-mono tabular-nums"
            )}
            style={
              isStatusError ? undefined : previewStyle ? { color: previewStyle.muted } : undefined
            }
          >
            {statusText}
          </span>
        </span>
        <span
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-full bg-black/10 backdrop-blur-sm transition-opacity duration-200",
            previewStyle ? "opacity-0" : "opacity-100"
          )}
        >
          <Plus
            aria-hidden="true"
            className="size-3.5"
            style={{ color: hintStyle && !previewStyle ? hintStyle.background : undefined }}
          />
        </span>
      </span>

      <span className="relative z-10 flex items-center justify-between">
        {previewStyle ? (
          <SourceCardChip />
        ) : (
          <span className="h-8 w-11 rounded-md border border-dashed border-current/30" />
        )}
      </span>

      <form className="relative z-10 flex items-center gap-2" onSubmit={handleSubmit} ref={formRef}>
        <input
          aria-invalid={isStatusError}
          aria-label={m["app.addWallet.inputLabel"]()}
          autoComplete="off"
          className={cn(
            "h-9 min-w-0 flex-1 rounded-lg border px-2.5 font-mono text-xs tabular-nums outline-none transition-colors",
            previewStyle
              ? "bg-white/16 text-current placeholder:text-current/45 backdrop-blur-md focus-visible:ring-2"
              : "bg-background/80 text-foreground placeholder:text-muted-foreground/70 focus-visible:ring-2",
            isStatusError
              ? "border-destructive/70 focus-visible:ring-destructive/40"
              : previewStyle
                ? "border-white/24 focus-visible:ring-white/35"
                : "border-border focus-visible:ring-ring/40"
          )}
          disabled={isSubmitting}
          onChange={(event) => {
            setValue(event.target.value)
            setHasSubmitError(false)
          }}
          onFocus={() => onActiveChange?.(true)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !isSubmitting) {
              event.stopPropagation()
              event.currentTarget.blur()
              deactivate()
            }
          }}
          placeholder={m["app.addWallet.placeholder"]()}
          ref={inputRef}
          spellCheck={false}
          type="text"
          value={value}
        />
        <button
          aria-label={m["app.addWallet.submit"]()}
          className={cn(
            "inline-flex size-9 shrink-0 touch-manipulation items-center justify-center rounded-full border transition-[background-color,opacity] duration-150 focus-visible:outline-none focus-visible:ring-2 [&_svg]:size-4",
            previewStyle
              ? "border-white/24 bg-white/16 text-current backdrop-blur-md hover:bg-white/24 focus-visible:ring-white/35"
              : "border-border bg-background/80 text-foreground focus-visible:ring-ring/40",
            canSubmit ? "opacity-100" : "pointer-events-none opacity-40"
          )}
          disabled={!canSubmit}
          type="submit"
        >
          {isSubmitting || isResolving ? (
            <Loader2 aria-hidden="true" className="animate-spin" />
          ) : (
            <ArrowRight aria-hidden="true" />
          )}
        </button>
      </form>
    </SourceCardShell>
  )
}

function formatResolvedAddress(address: string): string {
  return address.length <= 14 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`
}

function resolveErrorMessage(code: ResolveErrorCode | "unknown"): string {
  switch (code) {
    case "name_unresolved":
      return m["app.addWallet.resolveErrorNameUnresolved"]()
    case "network_unavailable":
      return m["app.addWallet.resolveErrorNetworkUnavailable"]()
    case "rate_limited":
      return m["app.addWallet.resolveErrorRateLimited"]()
    default:
      return m["app.addWallet.resolveError"]()
  }
}

function getStatusLine({
  detectedChain,
  hasSubmitError,
  isResolving,
  parse,
  resolveError,
  resolvedAddress,
  supportsNames,
}: {
  detectedChain: WalletChain | undefined
  hasSubmitError: boolean
  isResolving: boolean
  parse: ReturnType<typeof parseWalletInput>
  resolveError: ResolveErrorCode | "unknown" | undefined
  resolvedAddress: string | undefined
  supportsNames: boolean
}): { isStatusError: boolean; statusText: string } {
  if (hasSubmitError) {
    return { isStatusError: true, statusText: m["app.addWallet.error"]() }
  }

  if (parse.kind === "name") {
    if (!supportsNames) {
      return { isStatusError: false, statusText: m["app.addWallet.nameUnsupported"]() }
    }

    if (isResolving) {
      return { isStatusError: false, statusText: m["app.addWallet.resolving"]() }
    }

    if (resolveError !== undefined) {
      return { isStatusError: true, statusText: resolveErrorMessage(resolveError) }
    }

    if (resolvedAddress !== undefined) {
      return { isStatusError: false, statusText: formatResolvedAddress(resolvedAddress) }
    }

    return { isStatusError: false, statusText: m["app.addWallet.resolving"]() }
  }

  if (parse.kind === "unsupported") {
    return { isStatusError: false, statusText: m["app.addWallet.bitcoinUnsupported"]() }
  }

  if (parse.kind === "invalid") {
    return { isStatusError: true, statusText: m["app.addWallet.invalid"]() }
  }

  if (detectedChain === "evm") {
    return { isStatusError: false, statusText: m["app.addWallet.detectedEvm"]() }
  }

  if (detectedChain === "solana") {
    return { isStatusError: false, statusText: m["app.addWallet.detectedSolana"]() }
  }

  return { isStatusError: false, statusText: m["app.addWallet.subtitle"]() }
}
