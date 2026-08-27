/**
 * CoinbaseNetworkFee - Shared rule for network fees that are part of the Coinbase debit.
 *
 * @module CoinbaseNetworkFee
 */

/**
 * Whether a network fee is already counted into the primary `amount`. That is
 * the case when the fee uses the same currency as the primary amount; fees in
 * another currency or in the native fiat currency are tracked outside the
 * debit. The normalizer and the leg derivation must agree on this rule so the
 * principal movement and the disposal leg carry the same carved amount.
 */
export const feeIsPartOfDebit = ({
  feeCurrency,
  amountCurrency,
  nativeCurrency,
}: {
  readonly feeCurrency: string
  readonly amountCurrency: string
  readonly nativeCurrency: string
}): boolean => {
  const fee = feeCurrency.toUpperCase()

  return fee === amountCurrency.toUpperCase() && fee !== nativeCurrency.toUpperCase()
}
