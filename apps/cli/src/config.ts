import * as Config from "effect/Config"

export const DEFAULT_API_URL = "https://api.taxmaxi.com"
export const API_URL_ENV_VAR = "TAXMAXI_API_URL"
export const WORKFLOW_PROVIDER = "coinbase"
export const TAX_JURISDICTION = "germany"

export const resolveApiUrl = Config.string(API_URL_ENV_VAR).pipe(
  Config.map((configuredUrl) => {
    const trimmed = configuredUrl.trim()
    return trimmed.length > 0 ? trimmed : DEFAULT_API_URL
  }),
  Config.orElse(() => Config.succeed(DEFAULT_API_URL))
)
