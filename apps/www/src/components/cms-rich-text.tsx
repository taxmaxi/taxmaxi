import { Fragment, type ReactNode } from "react"

import type { LexicalDocument, LexicalNode, PayloadMedia } from "#/integrations/payload/content"

const TEXT_BOLD = 1
const TEXT_ITALIC = 2
const TEXT_STRIKETHROUGH = 4
const TEXT_UNDERLINE = 8
const TEXT_CODE = 16
const TEXT_SUBSCRIPT = 32
const TEXT_SUPERSCRIPT = 64

export function CmsRichText({ document }: { readonly document: LexicalDocument }) {
  return <>{renderChildren(document.root)}</>
}

function renderChildren(node: LexicalNode): ReactNode {
  return node.children?.map((child, index) => (
    <Fragment key={`${child.type}-${index}`}>{renderNode(child)}</Fragment>
  ))
}

function renderNode(node: LexicalNode): ReactNode {
  if (node.type === "text" && node.text !== undefined) {
    return renderText(node.text, typeof node.format === "number" ? node.format : 0)
  }

  if (node.type === "linebreak") return <br />

  if (node.type === "heading") {
    const children = renderChildren(node)
    if (node.tag === "h3") return <h3>{children}</h3>
    if (node.tag === "h4") return <h4>{children}</h4>
    if (node.tag === "h5") return <h5>{children}</h5>
    if (node.tag === "h6") return <h6>{children}</h6>
    return <h2>{children}</h2>
  }

  if (node.type === "paragraph") return <p>{renderChildren(node)}</p>
  if (node.type === "quote") return <blockquote>{renderChildren(node)}</blockquote>
  if (node.type === "listitem") return <li>{renderChildren(node)}</li>

  if (node.type === "list") {
    return node.listType === "number" ? (
      <ol>{renderChildren(node)}</ol>
    ) : (
      <ul>{renderChildren(node)}</ul>
    )
  }

  if (node.type === "link" || node.type === "autolink") {
    const href = safeHref(node.fields?.url ?? node.url)
    if (!href) return renderChildren(node)
    const newTab = node.fields?.newTab ?? false
    return (
      <a href={href} {...(newTab ? { target: "_blank", rel: "noreferrer" } : {})}>
        {renderChildren(node)}
      </a>
    )
  }

  if (node.type === "upload" && typeof node.value === "object") {
    return renderUpload(node.value)
  }

  return renderChildren(node)
}

function renderText(text: string, format: number): ReactNode {
  let content: ReactNode = text

  if (format & TEXT_CODE) content = <code>{content}</code>
  if (format & TEXT_BOLD) content = <strong>{content}</strong>
  if (format & TEXT_ITALIC) content = <em>{content}</em>
  if (format & TEXT_UNDERLINE) content = <u>{content}</u>
  if (format & TEXT_STRIKETHROUGH) content = <s>{content}</s>
  if (format & TEXT_SUBSCRIPT) content = <sub>{content}</sub>
  if (format & TEXT_SUPERSCRIPT) content = <sup>{content}</sup>

  return content
}

function renderUpload(media: PayloadMedia): ReactNode {
  if (!media.url) return null

  return (
    <figure>
      <img
        alt={media.alt}
        className="aspect-video w-full rounded-2xl object-cover"
        height={media.height ?? undefined}
        loading="lazy"
        src={media.url}
        width={media.width ?? undefined}
      />
      {media.alt ? <figcaption>{media.alt}</figcaption> : null}
    </figure>
  )
}

function safeHref(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  if (value.startsWith("/") || value.startsWith("#") || value.startsWith("mailto:")) return value

  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined
  } catch {
    return undefined
  }
}
