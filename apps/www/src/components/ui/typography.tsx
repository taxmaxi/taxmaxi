import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "#/lib/utils"

const headingVariants = cva("font-medium tracking-tight text-balance", {
  variants: {
    size: {
      eyebrow:
        "text-[length:var(--font-size-caption)] leading-[var(--line-height-caption)] uppercase tracking-[0.18em]",
      section:
        "text-[length:var(--font-size-title-sm)] leading-[var(--line-height-title-sm)] sm:text-[length:var(--font-size-title-md)] sm:leading-[var(--line-height-title-md)]",
      page: "text-[length:var(--font-size-title-md)] leading-[var(--line-height-title-md)]",
      display:
        "font-display font-bold text-[length:var(--font-size-title-lg)] leading-[var(--line-height-title-lg)] sm:text-[length:var(--font-size-display-sm)] sm:leading-[var(--line-height-display-sm)]",
      hero: "font-display font-bold text-[length:var(--font-size-display-sm)] leading-[var(--line-height-display-sm)] md:text-[length:var(--font-size-display-md)] md:leading-[var(--line-height-display-md)]",
    },
    tone: {
      default: "text-foreground",
      muted: "text-muted-foreground",
      brand: "text-off-white",
      inverse: "text-[#cde4d8]",
      auth: "text-[#1e4d40] dark:text-[#F7F0E3]",
    },
    align: {
      left: "text-left",
      center: "text-center",
      right: "text-right",
    },
  },
  defaultVariants: {
    size: "section",
    tone: "default",
    align: "left",
  },
})

const textVariants = cva("", {
  variants: {
    size: {
      caption: "text-[length:var(--font-size-caption)] leading-[var(--line-height-caption)]",
      bodySm: "text-[length:var(--font-size-body-sm)] leading-[var(--line-height-body-sm)]",
      body: "text-[length:var(--font-size-body)] leading-[var(--line-height-body)]",
      bodyLg: "text-[length:var(--font-size-body-lg)] leading-[var(--line-height-body-lg)]",
      lead: "text-[length:var(--font-size-body-lg)] leading-[var(--line-height-body-lg)]",
    },
    tone: {
      default: "text-foreground",
      muted: "text-muted-foreground",
      brand: "text-[#a3c4b5]",
      inverse: "text-[#a3c4b5]",
      auth: "text-[#2a6857] dark:text-[#a3c4b5]",
    },
    align: {
      left: "text-left",
      center: "text-center",
      right: "text-right",
    },
  },
  defaultVariants: {
    size: "body",
    tone: "default",
    align: "left",
  },
})

type HeadingProps = React.HTMLAttributes<HTMLHeadingElement> &
  VariantProps<typeof headingVariants> & {
    as?: "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
  }

function Heading({
  as: Comp = "h2",
  className,
  size = "section",
  tone = "default",
  align = "left",
  ...props
}: HeadingProps) {
  return <Comp className={cn(headingVariants({ size, tone, align }), className)} {...props} />
}

type TextProps = React.HTMLAttributes<HTMLParagraphElement> & VariantProps<typeof textVariants>

function Text({ className, size = "body", tone = "default", align = "left", ...props }: TextProps) {
  return <p className={cn(textVariants({ size, tone, align }), className)} {...props} />
}

function Eyebrow(props: Omit<HeadingProps, "as" | "size">) {
  const { className, tone = "default", align = "left", ...restProps } = props

  return (
    <p
      className={cn(headingVariants({ size: "eyebrow", tone, align }), className)}
      {...restProps}
    />
  )
}

type LeadProps = React.HTMLAttributes<HTMLParagraphElement> & VariantProps<typeof textVariants>

function Lead({ tone = "default", ...props }: LeadProps) {
  return <Text size="lead" tone={tone} {...props} />
}

function H1(props: Omit<HeadingProps, "as" | "size">) {
  return <Heading as="h1" size="section" tone="brand" align="center" {...props} />
}

export { Eyebrow, H1, Heading, Lead, Text, headingVariants, textVariants }

export default H1
