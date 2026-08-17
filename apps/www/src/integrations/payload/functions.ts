import { createServerFn } from "@tanstack/react-start"
import { setResponseHeader } from "@tanstack/react-start/server"
import { Schema } from "effect"

import { findLandingPage, findNewsArticle, findTaxLawArticle } from "./client.server"
import { payloadLocales } from "./content"
import { CMS_CACHE_CONTROL } from "./edge-cache.server"

const contentPageInput = Schema.standardSchemaV1(
  Schema.Struct({
    locale: Schema.Literal(...payloadLocales),
    slug: Schema.Trim.pipe(Schema.nonEmptyString(), Schema.maxLength(200)),
  })
)

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
