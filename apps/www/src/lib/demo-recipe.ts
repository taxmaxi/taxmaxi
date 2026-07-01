import { z } from "zod"

export const RecipeSchema = z.object({
  name: z.string().describe("The name of the recipe"),
  description: z.string().describe("A brief description of the dish"),
  prepTime: z.string().describe('Preparation time (e.g., "15 minutes")'),
  cookTime: z.string().describe('Cooking time (e.g., "30 minutes")'),
  servings: z.number().describe("Number of servings"),
  difficulty: z.enum(["easy", "medium", "hard"]).describe("Difficulty level"),
  ingredients: z
    .array(
      z.object({
        item: z.string().describe("Ingredient name"),
        amount: z.string().describe('Amount needed (e.g., "2 cups")'),
        notes: z.string().optional().describe("Optional preparation notes"),
      })
    )
    .describe("List of ingredients"),
  instructions: z.array(z.string()).describe("Step-by-step cooking instructions"),
  tips: z.array(z.string()).optional().describe("Optional cooking tips"),
  nutritionPerServing: z
    .object({
      calories: z.number().optional(),
      protein: z.string().optional(),
      carbs: z.string().optional(),
      fat: z.string().optional(),
    })
    .optional()
    .describe("Nutritional information per serving"),
})

export type Recipe = z.infer<typeof RecipeSchema>

export const RecipeGenerationResponseSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("structured"),
    recipe: RecipeSchema,
    provider: z.string(),
    model: z.string(),
  }),
  z.object({
    mode: z.literal("oneshot"),
    markdown: z.string(),
    provider: z.string(),
    model: z.string(),
  }),
])

export type RecipeGenerationResponse = z.infer<typeof RecipeGenerationResponseSchema>
