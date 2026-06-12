import { makeTaxMaxiEffectClient } from "taxmaxi"

export const makeCliTaxMaxiClient = ({
  apiUrl,
  sessionToken,
}: {
  readonly apiUrl: string
  readonly sessionToken?: string
}) =>
  makeTaxMaxiEffectClient({
    apiKey: sessionToken ?? "",
    baseUrl: apiUrl,
  })
