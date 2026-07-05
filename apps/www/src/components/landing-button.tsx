import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { Button } from "#/components/ui/button"
import { cn } from "#/lib/utils"

const landingButtonVariants = cva("", {
  variants: {
    variant: {
      cta: "rounded-lg border-cta-border bg-cta-background text-cta-foreground shadow-sm hover:bg-cta-background-hover",
      contrast:
        "rounded-lg border-marketing-contrast-border bg-marketing-contrast-background text-marketing-contrast-foreground hover:border-marketing-contrast-border-hover hover:bg-marketing-contrast-background-hover",
      primary:
        "rounded-full border border-marketing-border-muted bg-marketing-accent text-marketing-accent-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.32),0_10px_20px_rgba(27,73,50,0.22)] hover:bg-marketing-accent-hover",
      control:
        "rounded-full border border-marketing-border-muted bg-marketing-surface text-marketing-foreground hover:bg-marketing-surface-hover supports-[backdrop-filter]:backdrop-blur-md",
      "control-muted":
        "rounded-full border border-marketing-border-muted bg-marketing-surface text-marketing-muted hover:bg-marketing-surface-hover hover:text-marketing-foreground supports-[backdrop-filter]:backdrop-blur-md",
    },
    size: {
      action:
        "h-11 gap-2 px-4 text-sm has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
      pill: "h-10 gap-1.5 px-5 text-sm has-data-[icon=inline-end]:pr-4 has-data-[icon=inline-start]:pl-4",
      "modal-action":
        "h-12 gap-2 px-4 text-base font-semibold has-data-[icon=inline-end]:pr-4 has-data-[icon=inline-start]:pl-4",
      icon: "size-9",
      "icon-xl": "size-10",
    },
  },
  defaultVariants: {
    variant: "primary",
    size: "action",
  },
})

type LandingButtonProps = Omit<React.ComponentProps<typeof Button>, "size" | "variant"> &
  VariantProps<typeof landingButtonVariants>

function LandingButton({
  className,
  size = "action",
  variant = "primary",
  ...props
}: LandingButtonProps) {
  return (
    <Button
      className={cn(landingButtonVariants({ size, variant }), className)}
      variant="default"
      {...props}
    />
  )
}

export { LandingButton }
