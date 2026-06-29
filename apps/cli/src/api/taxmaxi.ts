import { makeTaxMaxiEffectClient } from "taxmaxi"

export const makeCliTaxMaxiClient = ({
  apiUrl,
  sessionToken,
}: {
  readonly apiUrl: string
  readonly sessionToken?: string
}) => {
  if (sessionToken === undefined || sessionToken === "") {
    return makeTaxMaxiEffectClient({
      apiKey: "",
      baseUrl: apiUrl,
    })
  }

  return makeTaxMaxiEffectClient({
    apiKey: sessionToken,
    baseUrl: apiUrl,
    headers: { authorization: `Bearer ${sessionToken}` },
  })
}
