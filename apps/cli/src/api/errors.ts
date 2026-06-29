import { toTaxMaxiError } from "taxmaxi"
import { CliCommandError } from "../errors.ts"

export const toCliApiError = (fallback: string) => (error: unknown) => {
  const taxMaxiError = toTaxMaxiError(error)
  return new CliCommandError({
    message: taxMaxiError.message === "" ? fallback : taxMaxiError.message,
    status: taxMaxiError.status,
  })
}
