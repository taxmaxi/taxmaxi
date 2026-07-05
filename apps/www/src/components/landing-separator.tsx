import * as React from "react"

import { Separator } from "#/components/ui/separator"
import { cn } from "#/lib/utils"

function LandingSeparator({ className, ...props }: React.ComponentProps<typeof Separator>) {
  return <Separator className={cn("bg-marketing-border-muted", className)} {...props} />
}

export { LandingSeparator }
