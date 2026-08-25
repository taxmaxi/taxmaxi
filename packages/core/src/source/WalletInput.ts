/**
 * WalletInput - Shared schemas for wallet-like user input.
 *
 * Models canonical onchain addresses and name-service aliases without
 * introducing any RPC-dependent behavior.
 *
 * @module source/WalletInput
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as SchemaIssue from "effect/SchemaIssue"
import * as SchemaTransformation from "effect/SchemaTransformation"

/**
 * Known ENS TLDs accepted as wallet-name input.
 */
export const ENS_TLDS = [".eth", ".cb.id", ".xyz", ".id"] as const

/**
 * SNS TLD accepted as wallet-name input.
 */
export const SNS_TLD = ".sol"

/**
 * ChainType - Supported blockchain families for wallet inputs.
 */
export const ChainType = Schema.Literals(["evm", "solana", "bitcoin"]).annotate({
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
 * Validates SNS name format without resolving it.
 */
export const isValidSnsName = (name: string): boolean => {
  const normalized = name.toLowerCase().trim()
  return normalized.endsWith(SNS_TLD) && normalized.length > SNS_TLD.length
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
export const GenericCryptoAddress = Schema.Trimmed.check(Schema.isNonEmpty())
  .pipe(
    Schema.check(
      Schema.makeFilter((address) =>
        detectAddressChainType(address) !== null ? undefined : "Invalid crypto address."
      )
    )
  )
  .annotate({
    identifier: "GenericCryptoAddress",
    title: "Generic Crypto Address",
    description: "Ethereum, Bitcoin, or Solana address string",
  })

/**
 * EnsName - ENS name format. This does not perform resolution.
 */
export const EnsName = Schema.Trimmed.check(Schema.isNonEmpty())
  .pipe(
    Schema.check(
      Schema.makeFilter((name) =>
        isValidEnsName(name)
          ? undefined
          : "Invalid ENS name format. Must end with .eth, .cb.id, .xyz, or .id"
      )
    )
  )
  .annotate({
    identifier: "EnsName",
    title: "ENS Name",
    description: "ENS-compatible wallet name format",
  })

/**
 * NameServiceNamespace - Supported wallet name-service namespaces.
 */
export const NameServiceNamespace = Schema.Literals(["ens", "sns"]).annotate({
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
 * Detects the name-service namespace a wallet name belongs to.
 */
export const detectNameServiceNamespace = (name: string): NameServiceNamespace | null => {
  if (isValidSnsName(name)) return "sns"
  if (isValidEnsName(name)) return "ens"
  return null
}

/**
 * Chain family the addresses of a name-service namespace belong to.
 */
export const chainTypeForNamespace = (namespace: NameServiceNamespace): ChainType =>
  namespace === "ens" ? "evm" : "solana"

/**
 * WalletAddressInput - Canonical wallet address input with chain typing.
 */
export class WalletAddressInput extends Schema.TaggedClass<WalletAddressInput>()(
  "WalletAddressInput",
  {
    address: Schema.Trimmed.check(Schema.isNonEmpty()).annotate({
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
  address: Schema.Trimmed.check(Schema.isNonEmpty()),
  chainType: ChainType,
}).annotate({
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
export const ValidatedCryptoAddress = GenericCryptoAddress.pipe(
  Schema.decodeTo(
    CryptoAddressWithChainType,
    SchemaTransformation.transformOrFail({
      decode: (address, options) => {
        const parsed = parseCryptoAddress(address)
        if (parsed === null) {
          return Effect.fail(
            new SchemaIssue.InvalidValue(
              { message: "Address validated but chain type could not be detected." },
              address,
              options
            )
          )
        }
        return Effect.succeed(parsed)
      },
      encode: ({ address }) => Effect.succeed(address),
    })
  )
).annotate({
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
  namespace: Schema.Literal("ens").annotate({
    title: "Namespace",
    description: "Ethereum Name Service namespace",
  }),
  chainType: Schema.Literal("evm").annotate({
    title: "Chain Type",
    description: "ENS names resolve to EVM wallet addresses",
  }),
  name: Schema.Trimmed.check(Schema.isNonEmpty()).annotate({
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
  namespace: Schema.Literal("sns").annotate({
    title: "Namespace",
    description: "Solana Name Service namespace",
  }),
  chainType: Schema.Literal("solana").annotate({
    title: "Chain Type",
    description: "SNS names resolve to Solana wallet addresses",
  }),
  name: Schema.Trimmed.check(Schema.isNonEmpty()).annotate({
    title: "Wallet Name",
    description: "Wallet name in the SNS namespace",
  }),
}) {}

/**
 * Type guard for SnsNameInput using Schema.is.
 */
export const isSnsNameInput = Schema.is(SnsNameInput)

/**
 * AddressOrNameInput - Parsed address or wallet name input.
 */
export type AddressOrNameInput =
  | { readonly type: "address"; readonly address: string; readonly chainType: ChainType }
  | { readonly type: "name"; readonly namespace: NameServiceNamespace; readonly name: string }

/**
 * AddressOrNameInputSchema - Object representation of parsed address or wallet name input.
 */
export const AddressOrNameInputSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("address"),
    address: Schema.Trimmed.check(Schema.isNonEmpty()),
    chainType: ChainType,
  }),
  Schema.Struct({
    type: Schema.Literal("name"),
    namespace: NameServiceNamespace,
    name: Schema.Trimmed.check(Schema.isNonEmpty()),
  }),
]).annotate({
  identifier: "AddressOrNameInput",
  title: "Address Or Name Input",
  description: "Parsed wallet address or wallet name input",
}) satisfies Schema.Schema<AddressOrNameInput>

/**
 * Parses a string into a wallet address or wallet name input.
 */
export const parseAddressOrName = (input: string): AddressOrNameInput | null => {
  const trimmed = input.trim()

  const namespace = detectNameServiceNamespace(trimmed)
  if (namespace !== null) {
    return { type: "name", namespace, name: trimmed.toLowerCase() }
  }

  const parsedAddress = parseCryptoAddress(trimmed)
  if (parsedAddress !== null) {
    return { type: "address", address: parsedAddress.address, chainType: parsedAddress.chainType }
  }

  return null
}

/**
 * AddressOrName - Valid crypto address or wallet name string.
 */
export const AddressOrName = Schema.Trimmed.check(Schema.isNonEmpty())
  .pipe(
    Schema.check(
      Schema.makeFilter((input) =>
        parseAddressOrName(input) !== null
          ? undefined
          : "Invalid input. Must be a valid crypto address or wallet name."
      )
    )
  )
  .annotate({
    identifier: "AddressOrName",
    title: "Address Or Name",
    description: "Crypto address or wallet name string",
  })

/**
 * ValidatedAddressOrName - Effect Schema that validates and parses address or wallet name input.
 */
export const ValidatedAddressOrName = AddressOrName.pipe(
  Schema.decodeTo(
    AddressOrNameInputSchema,
    SchemaTransformation.transformOrFail({
      decode: (input, options) => {
        const parsed = parseAddressOrName(input)
        if (parsed === null) {
          return Effect.fail(
            new SchemaIssue.InvalidValue(
              { message: "Input validated but could not be parsed." },
              input,
              options
            )
          )
        }
        return Effect.succeed(parsed)
      },
      encode: (input) => Effect.succeed(input.type === "address" ? input.address : input.name),
    })
  )
).annotate({
  identifier: "ValidatedAddressOrName",
  title: "Validated Address Or Name",
  description: "Address or wallet name string decoded to a discriminated input",
})

/**
 * WalletNameInput - Supported wallet name inputs.
 */
export type WalletNameInput = EnsNameInput | SnsNameInput

/**
 * Schema for wallet name inputs.
 */
export const WalletNameInputSchema = Schema.Union([EnsNameInput, SnsNameInput]).annotate({
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
export const WalletInputSchema = Schema.Union([
  WalletAddressInput,
  EnsNameInput,
  SnsNameInput,
]).annotate({
  identifier: "WalletInput",
  title: "Wallet Input",
  description: "Canonical wallet address input or supported wallet name input",
})

/**
 * Type guard for WalletInput using Schema.is.
 */
export const isWalletInput = Schema.is(WalletInputSchema)
