import { createFileRoute } from "@tanstack/react-router"
import { chat, maxIterations, toServerSentEventsResponse } from "@tanstack/ai"
import type { ModelMessage, UIMessage } from "@tanstack/ai"
import { anthropicText } from "@tanstack/ai-anthropic"
import { openaiText } from "@tanstack/ai-openai"
import { geminiText } from "@tanstack/ai-gemini"
import { ollamaText } from "@tanstack/ai-ollama"
import { z } from "zod"

import { getGuitars, recommendGuitarToolDef } from "#/lib/demo-guitar-tools"
import { getCaughtErrorMessage } from "#/lib/demo-ai-json"

type Provider = "anthropic" | "openai" | "gemini" | "ollama"
type DemoChatMessage = UIMessage | ModelMessage

const isDemoChatMessage = (value: unknown): value is DemoChatMessage => {
  if (typeof value !== "object" || value === null || !("role" in value)) {
    return false
  }

  const { role } = value
  if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
    return false
  }

  if ("parts" in value) {
    return Array.isArray(value.parts)
  }

  return "content" in value
}

const ChatRequestSchema = z.object({
  messages: z.array(z.custom<DemoChatMessage>(isDemoChatMessage)),
})

const getProvider = (): Provider => {
  if (process.env.ANTHROPIC_API_KEY) {
    return "anthropic"
  }

  if (process.env.OPENAI_API_KEY) {
    return "openai"
  }

  if (process.env.GEMINI_API_KEY) {
    return "gemini"
  }

  return "ollama"
}

const getAdapter = (provider: Provider) => {
  switch (provider) {
    case "anthropic":
      return anthropicText("claude-haiku-4-5")
    case "openai":
      return openaiText("gpt-4o")
    case "gemini":
      return geminiText("gemini-2.5-flash")
    case "ollama":
      return ollamaText("mistral:7b")
  }
}

const SYSTEM_PROMPT = `You are a helpful assistant for a store that sells guitars.

CRITICAL INSTRUCTIONS - YOU MUST FOLLOW THIS EXACT WORKFLOW:

When a user asks for a guitar recommendation:
1. FIRST: Use the getGuitars tool (no parameters needed)
2. SECOND: Use the recommendGuitar tool with the ID of the guitar you want to recommend
3. NEVER write a recommendation directly - ALWAYS use the recommendGuitar tool

IMPORTANT:
- The recommendGuitar tool will display the guitar in a special, appealing format
- You MUST use recommendGuitar for ANY guitar recommendation
- ONLY recommend guitars from our inventory (use getGuitars first)
- The recommendGuitar tool has a buy button - this is how customers purchase
- Do NOT describe the guitar yourself - let the recommendGuitar tool do it
`

export const Route = createFileRoute("/demo/api/ai/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Capture request signal before reading body (it may be aborted after body is consumed)
        const requestSignal = request.signal

        // If request is already aborted, return early
        if (requestSignal.aborted) {
          return new Response(null, { status: 499 }) // 499 = Client Closed Request
        }

        const abortController = new AbortController()

        try {
          const body: unknown = await request.json()
          const parsed = ChatRequestSchema.safeParse(body)
          if (!parsed.success) {
            return new Response(JSON.stringify({ error: "Invalid chat request" }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            })
          }

          const { messages } = parsed.data
          const adapter = getAdapter(getProvider())

          const stream = chat({
            adapter,
            tools: [
              getGuitars, // Server tool
              recommendGuitarToolDef, // No server execute - client will handle
            ],
            systemPrompts: [SYSTEM_PROMPT],
            agentLoopStrategy: maxIterations(5),
            messages,
            abortController,
          })

          return toServerSentEventsResponse(stream, { abortController })
        } catch (error: unknown) {
          // If request was aborted, return early (don't send error response)
          if (error instanceof Error && error.name === "AbortError") {
            return new Response(null, { status: 499 }) // 499 = Client Closed Request
          }

          if (abortController.signal.aborted) {
            return new Response(null, { status: 499 }) // 499 = Client Closed Request
          }

          return new Response(
            JSON.stringify({
              error: getCaughtErrorMessage(error, "Failed to process chat request"),
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
