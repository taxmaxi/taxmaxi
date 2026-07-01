import { createFileRoute } from "@tanstack/react-router"
import { chat } from "@tanstack/ai"
import { openaiText } from "@tanstack/ai-openai"
import { z } from "zod"

import { getCaughtErrorMessage } from "#/lib/demo-ai-json"
import { RecipeSchema } from "#/lib/demo-recipe"

export type { Recipe } from "#/lib/demo-recipe"

const StructuredRequestSchema = z.object({
  recipeName: z.string().trim().min(1),
  mode: z.enum(["structured", "oneshot"]).default("structured"),
})

export const Route = createFileRoute("/demo/api/ai/structured")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body: unknown = await request.json()
        const parsed = StructuredRequestSchema.safeParse(body)
        if (!parsed.success) {
          return new Response(
            JSON.stringify({
              error: "Recipe name is required",
            }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            }
          )
        }

        const { recipeName, mode } = parsed.data

        try {
          if (mode === "structured") {
            // Structured output mode - returns validated object
            const result = await chat({
              adapter: openaiText("gpt-4o"),
              messages: [
                {
                  role: "user",
                  content: `Generate a complete recipe for: ${recipeName}. Include all ingredients with amounts, step-by-step instructions, prep/cook times, and difficulty level.`,
                },
              ],
              outputSchema: RecipeSchema,
            })

            return new Response(
              JSON.stringify({
                mode: "structured",
                recipe: result,
                provider: "openai",
                model: "gpt-4o",
              }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              }
            )
          } else {
            // One-shot markdown mode - returns text
            const markdown = await chat({
              adapter: openaiText("gpt-4o"),
              stream: false,
              messages: [
                {
                  role: "user",
                  content: `Generate a complete recipe for: ${recipeName}.

Format the recipe in beautiful markdown with:
- A title with the recipe name
- A brief description
- Prep time, cook time, and servings
- Ingredients list with amounts
- Numbered step-by-step instructions
- Optional tips section
- Nutritional info if applicable

Make it detailed and easy to follow.`,
                },
              ],
            })

            return new Response(
              JSON.stringify({
                mode: "oneshot",
                markdown,
                provider: "openai",
                model: "gpt-4o",
              }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              }
            )
          }
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
