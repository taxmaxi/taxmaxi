export const seo = ({
  title,
  description,
  keywords,
  image,
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
}) => {
  const tags = [
    { title },
    { name: "description", content: description },
    { name: "keywords", content: keywords },
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: description },
    { name: "twitter:creator", content: "@TaxMaxiHQ" },
    { name: "twitter:site", content: "@TaxMaxiHQ" },
    { property: "og:type", content: "website" },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    ...(image
      ? [
          { property: "og:image", content: image.url },
          ...(image.type ? [{ property: "og:image:type", content: image.type }] : []),
          ...(image.width ? [{ property: "og:image:width", content: image.width }] : []),
          ...(image.height ? [{ property: "og:image:height", content: image.height }] : []),
          ...(image.alt ? [{ property: "og:image:alt", content: image.alt }] : []),
          { name: "twitter:card", content: "summary_large_image" },
          { name: "twitter:image", content: image.url },
        ]
      : []),
  ]

  return tags
}
