/**
 * Frontend wallet-input detection for the add-wallet card.
 *
 * Mirrors the address grammar in @my/core/source/WalletInput.ts without
 * importing it: apps/www stays Effect-free, and the backend re-validates
 * every input on create anyway.
 */

import { z } from "zod"

export type WalletChain = "evm" | "solana"

export type WalletInputParse =
  | { kind: "empty" }
  | { kind: "partial"; hint?: WalletChain }
  | { kind: "address"; chain: WalletChain; address: string }
  | { kind: "name"; chain: WalletChain; name: string }
  | { kind: "unsupported"; reason: "bitcoin" }
  | { kind: "invalid" }

const EVM_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/
const EVM_PREFIX_PATTERN = /^0(x[a-fA-F0-9]{0,39})?$/
const BITCOIN_ADDRESS_PATTERN = /^(1|3|bc1)[a-zA-Z0-9]{25,62}$/
const SOLANA_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const SOLANA_PREFIX_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{1,31}$/
const NAME_CHARS_PATTERN = /^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]*)+$/

const ENS_TLDS = [".eth", ".cb.id", ".xyz", ".id"] as const
const SNS_TLD = ".sol"

function detectNameChain(value: string): WalletChain | undefined {
  const normalized = value.toLowerCase()

  if (normalized.endsWith(SNS_TLD) && normalized.length > SNS_TLD.length) {
    return "solana"
  }

  const isEnsName = ENS_TLDS.some(
    (tld) => normalized.endsWith(tld) && normalized.length > tld.length
  )

  return isEnsName ? "evm" : undefined
}

/**
 * Stable resolution error codes sent by the backend. Mirrors
 * WALLET_NAME_RESOLUTION_ERROR_CODES in @my/core without importing it:
 * apps/www stays Effect-free.
 */
export const RESOLVE_ERROR_CODES = [
  "invalid_name",
  "name_unresolved",
  "network_unavailable",
  "rate_limited",
  "resolution_failed",
] as const

export type ResolveErrorCode = (typeof RESOLVE_ERROR_CODES)[number]

const resolveErrorSchema = z.object({ code: z.enum(RESOLVE_ERROR_CODES) })
const resolveErrorCauseSchema = z.object({ cause: resolveErrorSchema })

/**
 * Pulls the stable resolution error code out of an unknown SDK rejection,
 * looking at the error itself and one `cause` level down.
 */
export function parseResolveErrorCode(error: unknown): ResolveErrorCode | undefined {
  const direct = resolveErrorSchema.safeParse(error)

  if (direct.success) {
    return direct.data.code
  }

  const nested = resolveErrorCauseSchema.safeParse(error)

  return nested.success ? nested.data.cause.code : undefined
}

/**
 * Classifies raw input while the user types. Address checks run in the same
 * order as the backend (EVM, then Bitcoin, then Solana) so an ambiguous
 * base58 string resolves to the same chain on both sides.
 */
export function parseWalletInput(rawValue: string): WalletInputParse {
  const value = rawValue.trim()

  if (value === "") {
    return { kind: "empty" }
  }

  if (EVM_ADDRESS_PATTERN.test(value)) {
    return { kind: "address", chain: "evm", address: value }
  }

  if (EVM_PREFIX_PATTERN.test(value)) {
    return { kind: "partial", hint: "evm" }
  }

  if (BITCOIN_ADDRESS_PATTERN.test(value)) {
    return { kind: "unsupported", reason: "bitcoin" }
  }

  if (SOLANA_ADDRESS_PATTERN.test(value)) {
    return { kind: "address", chain: "solana", address: value }
  }

  if (SOLANA_PREFIX_PATTERN.test(value)) {
    return { kind: "partial" }
  }

  if (NAME_CHARS_PATTERN.test(value)) {
    const chain = detectNameChain(value)

    return chain === undefined
      ? { kind: "partial" }
      : { kind: "name", chain, name: value.toLowerCase() }
  }

  return { kind: "invalid" }
}
