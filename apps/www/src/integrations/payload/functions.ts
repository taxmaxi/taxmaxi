import { createServerFn } from "@tanstack/react-start"
import { setResponseHeader } from "@tanstack/react-start/server"
import { z } from "zod"

import { findLandingPage, findNewsArticle, findTaxLawArticle } from "./client.server"
import { payloadLocales } from "./content"

const CMS_CACHE_CONTROL = "public, max-age=60, s-maxage=300, stale-while-revalidate=86400"

const contentPageInput = z.object({
  locale: z.enum(payloadLocales),
  slug: z.string().trim().min(1).max(200),
})

function setCmsCacheHeaders() {
  setResponseHeader("Cache-Control", CMS_CACHE_CONTROL)
}

export const getLandingPage = createServerFn({ method: "GET" })
  .validator(contentPageInput)
  .handler(async ({ data }) => {
    const page = await findLandingPage(data)
    setCmsCacheHeaders()
    return page
  })

export const getNewsArticle = createServerFn({ method: "GET" })
  .validator(contentPageInput)
  .handler(async ({ data }) => {
    const page = await findNewsArticle(data)
    setCmsCacheHeaders()
    return page
  })

export const getTaxLawArticle = createServerFn({ method: "GET" })
  .validator(contentPageInput)
  .handler(async ({ data }) => {
    const page = await findTaxLawArticle(data)
    setCmsCacheHeaders()
    return page
  })
