import { createServerFn } from "@tanstack/react-start"
import { setResponseHeader } from "@tanstack/react-start/server"
import { z } from "zod"

import { findLandingPage, findNewsArticle, findTaxLawArticle } from "./client.server"
import {
  CLOUDFLARE_CACHE_CONTROL_HEADER,
  CMS_BROWSER_CACHE_CONTROL,
  CMS_CACHE_TAG,
  CMS_EDGE_CACHE_CONTROL,
} from "./cache-policy.server"
import { payloadLocales } from "./content"

const contentPageInput = z.object({
  locale: z.enum(payloadLocales),
  slug: z.string().trim().min(1).max(200),
})

function setCmsCacheHeaders() {
  setResponseHeader("Cache-Control", CMS_BROWSER_CACHE_CONTROL)
  setResponseHeader(CLOUDFLARE_CACHE_CONTROL_HEADER, CMS_EDGE_CACHE_CONTROL)
  setResponseHeader("Cache-Tag", CMS_CACHE_TAG)
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
