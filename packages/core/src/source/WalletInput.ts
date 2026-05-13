/**
 * WalletInput - Shared schemas for wallet-like user input.
 *
 * Models canonical onchain addresses and name-service aliases without
 * introducing any RPC-dependent behavior.
 *
 * @module source/WalletInput
 */

import * as Effect from "effect/Effect"
import * as ParseResult from "effect/ParseResult"
import * as Schema from "effect/Schema"

/**
 * Known ENS TLDs accepted as wallet-name input.
 */
export const ENS_TLDS = [".eth", ".cb.id", ".xyz", ".id"] as const

/**
 * ChainType - Supported blockchain families for wallet inputs.
 */
export const ChainType = Schema.Literal("evm", "solana", "bitcoin").annotations({
  identifier: "ChainType",
  title: "Chain Type",
  description: "Blockchain family for a wallet address or resolved wallet name",
})

/**
 * The ChainType type.
 */
export type ChainType = typeof ChainType.Type

/**
 * Type guard for ChainType using Schema.is.
 */
export const isChainType = Schema.is(ChainType)

/**
 * Validates Ethereum-style EVM addresses.
 */
export const isValidEthereumAddress = (address: string): boolean =>
  /^0x[a-fA-F0-9]{40}$/.test(address)

/**
 * Validates ENS name format without resolving it.
 */
export const isValidEnsName = (name: string): boolean => {
  const normalized = name.toLowerCase().trim()
  return ENS_TLDS.some((tld) => normalized.endsWith(tld) && normalized.length > tld.length)
}

/**
 * Validates common Bitcoin address formats.
 */
export const isValidBitcoinAddress = (address: string): boolean =>
  /^(1|3|bc1)[a-zA-Z0-9]{25,62}$/.test(address)

/**
 * Validates Solana base58 address format.
 */
export const isValidSolanaAddress = (address: string): boolean =>
  /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)

/**
 * Detects the likely chain family for a crypto address string.
 */
export const detectAddressChainType = (address: string): ChainType | null => {
  if (isValidEthereumAddress(address)) return "evm"
  if (isValidBitcoinAddress(address)) return "bitcoin"
  if (isValidSolanaAddress(address)) return "solana"
  return null
}

/**
 * GenericCryptoAddress - Valid Ethereum, Bitcoin, or Solana address string.
 */
export const GenericCryptoAddress = Schema.NonEmptyTrimmedString.pipe(
  Schema.filter((address) => detectAddressChainType(address) !== null, {
    message: () => "Invalid crypto address.",
  })
).annotations({
  identifier: "GenericCryptoAddress",
  title: "Generic Crypto Address",
  description: "Ethereum, Bitcoin, or Solana address string",
})

/**
 * EnsName - ENS name format. This does not perform resolution.
 */
export const EnsName = Schema.NonEmptyTrimmedString.pipe(
  Schema.filter(isValidEnsName, {
    message: () => "Invalid ENS name format. Must end with .eth, .cb.id, .xyz, or .id",
  })
).annotations({
  identifier: "EnsName",
  title: "ENS Name",
  description: "ENS-compatible wallet name format",
})

/**
 * NameServiceNamespace - Supported wallet name-service namespaces.
 */
export const NameServiceNamespace = Schema.Literal("ens", "sns").annotations({
  identifier: "NameServiceNamespace",
  title: "Name Service Namespace",
  description: "Supported namespace for wallet name resolution",
})

/**
 * The NameServiceNamespace type.
 */
export type NameServiceNamespace = typeof NameServiceNamespace.Type

/**
 * Type guard for NameServiceNamespace using Schema.is.
 */
export const isNameServiceNamespace = Schema.is(NameServiceNamespace)

/**
 * WalletAddressInput - Canonical wallet address input with chain typing.
 */
export class WalletAddressInput extends Schema.TaggedClass<WalletAddressInput>()(
  "WalletAddressInput",
  {
    address: Schema.NonEmptyTrimmedString.annotations({
      title: "Wallet Address",
      description: "Canonical onchain wallet address string",
    }),
    chainType: ChainType,
  }
) {}

/**
 * CryptoAddressWithChainType - Object representation of an inferred address.
 */
export const CryptoAddressWithChainType = Schema.Struct({
  address: Schema.NonEmptyTrimmedString,
  chainType: ChainType,
}).annotations({
  identifier: "CryptoAddressWithChainType",
  title: "Crypto Address With Chain Type",
  description: "Validated crypto address with inferred chain family",
})

/**
 * The CryptoAddressWithChainType type.
 */
export type CryptoAddressWithChainType = typeof CryptoAddressWithChainType.Type

/**
 * Parses a crypto address and returns its inferred chain family.
 */
export const parseCryptoAddress = (address: string): CryptoAddressWithChainType | null => {
  const trimmed = address.trim()
  const chainType = detectAddressChainType(trimmed)
  if (chainType === null) {
    return null
  }
  return { address: trimmed, chainType }
}

/**
 * ValidatedCryptoAddress - Effect Schema that validates and infers address chain type.
 */
export const ValidatedCryptoAddress = Schema.transformOrFail(
  GenericCryptoAddress,
  CryptoAddressWithChainType,
  {
    strict: true,
    decode: (address, _, ast) => {
      const parsed = parseCryptoAddress(address)
      if (parsed === null) {
        return Effect.fail(
          new ParseResult.Type(ast, address, "Address validated but chain type could not be detected.")
        )
      }
      return Effect.succeed(parsed)
    },
    encode: ({ address }) => Effect.succeed(address),
  }
).annotations({
  identifier: "ValidatedCryptoAddress",
  title: "Validated Crypto Address",
  description: "Crypto address string decoded to address plus inferred chain family",
})

/**
 * Type guard for WalletAddressInput using Schema.is.
 */
export const isWalletAddressInput = Schema.is(WalletAddressInput)

/**
 * EnsNameInput - ENS namespace wallet name input.
 */
export class EnsNameInput extends Schema.TaggedClass<EnsNameInput>()("EnsNameInput", {
  namespace: Schema.Literal("ens").annotations({
    title: "Namespace",
    description: "Ethereum Name Service namespace",
  }),
  chainType: Schema.Literal("evm").annotations({
    title: "Chain Type",
    description: "ENS names resolve to EVM wallet addresses",
  }),
  name: Schema.NonEmptyTrimmedString.annotations({
    title: "Wallet Name",
    description: "Wallet name in the ENS namespace",
  }),
}) {}

/**
 * Type guard for EnsNameInput using Schema.is.
 */
export const isEnsNameInput = Schema.is(EnsNameInput)

/**
 * SnsNameInput - SNS namespace wallet name input.
 */
export class SnsNameInput extends Schema.TaggedClass<SnsNameInput>()("SnsNameInput", {
  namespace: Schema.Literal("sns").annotations({
    title: "Namespace",
    description: "Solana Name Service namespace",
  }),
  chainType: Schema.Literal("solana").annotations({
    title: "Chain Type",
    description: "SNS names resolve to Solana wallet addresses",
  }),
  name: Schema.NonEmptyTrimmedString.annotations({
    title: "Wallet Name",
    description: "Wallet name in the SNS namespace",
  }),
}) {}

/**
 * Type guard for SnsNameInput using Schema.is.
 */
export const isSnsNameInput = Schema.is(SnsNameInput)

/**
 * AddressOrEnsInput - Parsed address or ENS name input.
 */
export type AddressOrEnsInput =
  | { readonly type: "address"; readonly address: string; readonly chainType: ChainType }
  | { readonly type: "ens"; readonly ensName: string }

/**
 * AddressOrEnsInputSchema - Object representation of parsed address or ENS input.
 */
export const AddressOrEnsInputSchema: Schema.Schema<AddressOrEnsInput> = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("address"),
    address: Schema.NonEmptyTrimmedString,
    chainType: ChainType,
  }),
  Schema.Struct({
    type: Schema.Literal("ens"),
    ensName: EnsName,
  })
).annotations({
  identifier: "AddressOrEnsInput",
  title: "Address Or ENS Input",
  description: "Parsed wallet address or ENS name input",
})

/**
 * Parses a string into a wallet address or ENS name input.
 */
export const parseAddressOrEns = (input: string): AddressOrEnsInput | null => {
  const trimmed = input.trim()

  if (isValidEnsName(trimmed)) {
    return { type: "ens", ensName: trimmed.toLowerCase() }
  }

  const parsedAddress = parseCryptoAddress(trimmed)
  if (parsedAddress !== null) {
    return { type: "address", address: parsedAddress.address, chainType: parsedAddress.chainType }
  }

  return null
}

/**
 * AddressOrEns - Valid crypto address or ENS name string.
 */
export const AddressOrEns = Schema.NonEmptyTrimmedString.pipe(
  Schema.filter((input) => parseAddressOrEns(input) !== null, {
    message: () => "Invalid input. Must be a valid crypto address or ENS name.",
  })
).annotations({
  identifier: "AddressOrEns",
  title: "Address Or ENS",
  description: "Crypto address or ENS name string",
})

/**
 * ValidatedAddressOrEns - Effect Schema that validates and parses address or ENS input.
 */
export const ValidatedAddressOrEns = Schema.transformOrFail(AddressOrEns, AddressOrEnsInputSchema, {
  strict: true,
  decode: (input, _, ast) => {
    const parsed = parseAddressOrEns(input)
    if (parsed === null) {
      return Effect.fail(new ParseResult.Type(ast, input, "Input validated but could not be parsed."))
    }
    return Effect.succeed(parsed)
  },
  encode: (input) => Effect.succeed(input.type === "address" ? input.address : input.ensName),
}).annotations({
  identifier: "ValidatedAddressOrEns",
  title: "Validated Address Or ENS",
  description: "Address or ENS string decoded to a discriminated input",
})

/**
 * WalletNameInput - Supported wallet name inputs.
 */
export type WalletNameInput = EnsNameInput | SnsNameInput

/**
 * Schema for wallet name inputs.
 */
export const WalletNameInputSchema = Schema.Union(EnsNameInput, SnsNameInput).annotations({
  identifier: "WalletNameInput",
  title: "Wallet Name Input",
  description: "Wallet name in a supported name-service namespace",
})

/**
 * Type guard for WalletNameInput using Schema.is.
 */
export const isWalletNameInput = Schema.is(WalletNameInputSchema)

/**
 * WalletInput - Union of supported wallet-like inputs.
 */
export type WalletInput = WalletAddressInput | WalletNameInput

/**
 * Schema for discriminated wallet inputs.
 */
export const WalletInputSchema = Schema.Union(
  WalletAddressInput,
  EnsNameInput,
  SnsNameInput
).annotations({
  identifier: "WalletInput",
  title: "Wallet Input",
  description: "Canonical wallet address input or supported wallet name input",
})

/**
 * Type guard for WalletInput using Schema.is.
 */
export const isWalletInput = Schema.is(WalletInputSchema)
