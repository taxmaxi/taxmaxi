import { createFileRoute } from "@tanstack/react-router"
import { generateImage, createImageOptions } from "@tanstack/ai"
import { openaiImage } from "@tanstack/ai-openai"
import { z } from "zod"

import { getCaughtErrorMessage } from "#/lib/demo-ai-json"

const ImageRequestSchema = z.object({
  prompt: z.string().trim().min(1),
  numberOfImages: z.number().int().min(1).max(4).default(1),
  size: z.enum(["1024x1024", "1536x1024", "1024x1536", "auto"]).default("1024x1024"),
})

export const Route = createFileRoute("/demo/api/ai/image")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body: unknown = await request.json()
        const parsed = ImageRequestSchema.safeParse(body)
        if (!parsed.success) {
          return new Response(
            JSON.stringify({
              error: "Prompt is required",
            }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            }
          )
        }

        const { prompt, numberOfImages, size } = parsed.data

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
          const options = createImageOptions({
            adapter: openaiImage("gpt-image-1"),
            prompt,
            numberOfImages,
            size,
          })

          const result = await generateImage(options)

          return new Response(
            JSON.stringify({
              images: result.images,
              model: "gpt-image-1",
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
