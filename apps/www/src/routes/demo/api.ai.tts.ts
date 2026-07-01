import { createFileRoute } from "@tanstack/react-router"
import { generateSpeech } from "@tanstack/ai"
import { openaiSpeech } from "@tanstack/ai-openai"
import { z } from "zod"

import { getCaughtErrorMessage } from "#/lib/demo-ai-json"

const TTSRequestSchema = z.object({
  text: z.string().trim().min(1),
  voice: z
    .enum([
      "alloy",
      "ash",
      "ballad",
      "coral",
      "echo",
      "fable",
      "onyx",
      "nova",
      "sage",
      "shimmer",
      "verse",
    ])
    .default("alloy"),
  model: z.enum(["tts-1", "tts-1-hd", "gpt-4o-audio-preview"]).default("tts-1"),
  format: z.enum(["mp3", "opus", "aac", "flac", "wav", "pcm"]).default("mp3"),
  speed: z.number().min(0.25).max(4).default(1),
})

export const Route = createFileRoute("/demo/api/ai/tts")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body: unknown = await request.json()
        const parsed = TTSRequestSchema.safeParse(body)
        if (!parsed.success) {
          return new Response(
            JSON.stringify({
              error: "Text is required",
            }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            }
          )
        }

        const { text, voice, model, format, speed } = parsed.data

        if (!process.env.OPENAI_API_KEY) {
          return new Response(
            JSON.stringify({
              error: "OPENAI_API_KEY is not configured",
            }),
            {
              status: 500,
              headers: { "Content-Type": "application/json" },
            }
          )
        }

        try {
          const adapter = openaiSpeech(model)

          const result = await generateSpeech({
            adapter,
            text,
            voice,
            format,
            speed,
          })

          return new Response(
            JSON.stringify({
              id: result.id,
              model: result.model,
              audio: result.audio,
              format: result.format,
              contentType: result.contentType,
              duration: result.duration,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          )
        } catch (error: unknown) {
          return new Response(
            JSON.stringify({
              error: getCaughtErrorMessage(error, "An error occurred"),
            }),
            {
              status: 500,
              headers: { "Content-Type": "application/json" },
            }
          )
        }
      },
    },
  },
})
