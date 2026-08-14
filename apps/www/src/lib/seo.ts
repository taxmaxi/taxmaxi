export const seo = ({
  title,
  description,
  keywords,
  image,
  type = "website",
  url,
  robots,
}: {
  title: string
  description?: string
  image?: {
    url: string
    type?: string
    width?: string
    height?: string
    alt?: string
  }
  keywords?: string
  type?: "article" | "website"
  url?: string
  robots?: string
}) => {
  const tags: Array<
    { title: string } | { name: string; content: string } | { property: string; content: string }
  > = [
    { title },
    { name: "twitter:title", content: title },
    { name: "twitter:creator", content: "@TaxMaxiHQ" },
    { name: "twitter:site", content: "@TaxMaxiHQ" },
    { property: "og:type", content: type },
    { property: "og:title", content: title },
  ]

  if (description) {
    tags.push(
      { name: "description", content: description },
      { name: "twitter:description", content: description },
      { property: "og:description", content: description }
    )
  }

  if (keywords) tags.push({ name: "keywords", content: keywords })
  if (robots) tags.push({ name: "robots", content: robots })
  if (url) tags.push({ property: "og:url", content: url })

  if (image) {
    tags.push(
      { property: "og:image", content: image.url },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:image", content: image.url }
    )
    if (image.type) tags.push({ property: "og:image:type", content: image.type })
    if (image.width) tags.push({ property: "og:image:width", content: image.width })
    if (image.height) tags.push({ property: "og:image:height", content: image.height })
    if (image.alt) tags.push({ property: "og:image:alt", content: image.alt })
  }

  return tags
}
