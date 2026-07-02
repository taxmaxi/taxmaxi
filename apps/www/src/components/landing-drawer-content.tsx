import { type ComponentProps } from "react"

import { DrawerContent } from "#/components/ui/drawer"
import { cn } from "#/lib/utils"

type LandingDrawerContentProps = Omit<ComponentProps<typeof DrawerContent>, "placement">

export function LandingDrawerContent({
  className,
  handleClassName,
  overlayClassName,
  ...props
}: LandingDrawerContentProps) {
  return (
    <DrawerContent
      className={cn(
        "overflow-hidden border border-white/12 bg-[linear-gradient(180deg,rgba(17,28,23,0.82),rgba(9,15,12,0.7))] text-[#eef7f1] shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_24px_90px_rgba(0,0,0,0.36)] backdrop-blur-[18px]",
        className
      )}
      handleClassName={cn("mb-4 mt-3 block h-1.5 w-12 bg-white/14", handleClassName)}
      overlayClassName={cn("bg-black/32 backdrop-blur-[3px]", overlayClassName)}
      placement="bottom-floating"
      {...props}
    />
  )
}
