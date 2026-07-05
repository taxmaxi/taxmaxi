import * as React from "react"

import { Button } from "#/components/ui/button"
import { cn } from "#/lib/utils"

type LandingHeaderButtonProps = Omit<React.ComponentProps<typeof Button>, "size" | "variant">

function LandingHeaderNavButton({ className, ...props }: LandingHeaderButtonProps) {
  return (
    <Button
      className={cn(
        "h-10 gap-1.5 rounded-full bg-transparent px-4 text-sm text-marketing-muted hover:bg-transparent hover:text-marketing-hover data-[active=true]:text-marketing-foreground",
        className
      )}
      variant="ghost"
      {...props}
    />
  )
}

function LandingHeaderDrawerNavButton({ className, ...props }: LandingHeaderButtonProps) {
  return (
    <Button
      className={cn(
        "h-auto justify-start rounded-full border border-transparent bg-transparent px-4 py-2.5 text-[1rem] font-semibold text-marketing-muted hover:bg-marketing-surface-hover-muted hover:text-marketing-hover data-[active=true]:border-marketing-border-muted data-[active=true]:bg-marketing-surface-active data-[active=true]:text-marketing-foreground data-[active=true]:shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]",
        className
      )}
      variant="ghost"
      {...props}
    />
  )
}

export { LandingHeaderDrawerNavButton, LandingHeaderNavButton }
