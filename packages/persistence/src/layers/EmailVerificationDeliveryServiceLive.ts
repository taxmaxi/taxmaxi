/**
 * @module EmailVerificationDeliveryServiceLive
 *
 * Resend-backed delivery for local email verification codes.
 */

import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import { Resend } from "resend"
import {
  EmailVerificationDeliveryError,
  EmailVerificationDeliveryService,
  type EmailVerificationDeliveryServiceShape,
} from "../services/EmailVerificationDeliveryService.ts"

const DEFAULT_VERIFICATION_FROM = "TaxMaxi <taxmaxi@updates.taxmaxi.com>"
const RESEND_DELIVERY_MODE = "resend"
const LOG_DELIVERY_MODE = "log"

const verificationEmailHtml = (code: string) => `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f6f7f8;color:#0f1720;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
    <main style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #d9e0e6;border-radius:16px;padding:32px;">
      <p style="margin:0 0 12px;font-size:14px;color:#4b5563;">TaxMaxi email verification</p>
      <h1 style="margin:0 0 16px;font-size:28px;line-height:1.2;color:#111827;">Confirm your email</h1>
      <p style="margin:0 0 24px;font-size:16px;line-height:1.6;color:#374151;">
        Use this verification code to finish signing in to TaxMaxi.
      </p>
      <div style="margin:0 0 24px;padding:20px 24px;border-radius:14px;background:#0f1720;color:#f8fafc;font-size:28px;font-weight:700;letter-spacing:0.32em;text-align:center;">
        ${code}
      </div>
      <p style="margin:0;font-size:14px;line-height:1.6;color:#6b7280;">
        This code expires in 10 minutes. If you did not request it, you can ignore this email.
      </p>
    </main>
  </body>
</html>`

const make = Effect.gen(function* () {
  const environment = yield* Config.string("ENVIRONMENT").pipe(Config.withDefault("development"))
  const deliveryMode = yield* Config.string("AUTH_VERIFICATION_DELIVERY_MODE").pipe(
    Config.withDefault(environment === "production" ? RESEND_DELIVERY_MODE : LOG_DELIVERY_MODE)
  )
  const fromAddress = yield* Config.string("AUTH_VERIFICATION_EMAIL_FROM").pipe(
    Config.withDefault(DEFAULT_VERIFICATION_FROM)
  )

  if (deliveryMode === LOG_DELIVERY_MODE) {
    const sendVerificationCode: EmailVerificationDeliveryServiceShape["sendVerificationCode"] = ({
      email,
      code,
    }) =>
      Effect.logInfo(
        {
          email,
          code,
          deliveryMode,
        },
        "Verification code generated"
      )

    return {
      sendVerificationCode,
    } satisfies EmailVerificationDeliveryServiceShape
  }

  const resendApiKey = yield* Config.redacted("RESEND_API_KEY")
  const resend = new Resend(Redacted.value(resendApiKey))

  const sendVerificationCode: EmailVerificationDeliveryServiceShape["sendVerificationCode"] = ({
    email,
    code,
  }) =>
    Effect.tryPromise({
      try: async () => {
        const result = await resend.emails.send({
          from: fromAddress,
          to: [email],
          subject: "Your TaxMaxi verification code",
          text: `Your TaxMaxi verification code is: ${code}`,
          html: verificationEmailHtml(code),
        })

        if (result.error) {
          throw result.error
        }
      },
      catch: (cause) =>
        new EmailVerificationDeliveryError({
          message: "Failed to send verification email",
          cause,
        }),
    }).pipe(
      Effect.tap(() => Effect.logInfo({ email }, "Sent verification email")),
      Effect.tapError((error) =>
        Effect.logError(
          {
            email,
            cause: error.cause,
            deliveryMode,
          },
          "Failed to send verification email"
        )
      )
    )

  return {
    sendVerificationCode,
  } satisfies EmailVerificationDeliveryServiceShape
})

/**
 * Live verification email delivery via Resend.
 */
export const EmailVerificationDeliveryServiceLive = Layer.effect(
  EmailVerificationDeliveryService,
  make
)
