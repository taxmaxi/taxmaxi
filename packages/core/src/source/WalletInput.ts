/**
 * WalletInput - Shared schemas for wallet-like user input.
 *
 * Models canonical onchain addresses and name-service aliases without
 * introducing any RPC-dependent behavior.
 *
 * @module source/WalletInput
 */

import * as Schema from "effect/Schema"

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
