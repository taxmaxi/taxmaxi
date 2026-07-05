import * as React from "react"
import { Drawer as DrawerPrimitive } from "vaul"

import { cn } from "#/lib/utils"

function BottomSheet({ ...props }: React.ComponentProps<typeof DrawerPrimitive.Root>) {
  return <DrawerPrimitive.Root data-slot="bottom-sheet" {...props} />
}

function BottomSheetPortal({ ...props }: React.ComponentProps<typeof DrawerPrimitive.Portal>) {
  return <DrawerPrimitive.Portal data-slot="bottom-sheet-portal" {...props} />
}

function BottomSheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Overlay>) {
  return (
    <DrawerPrimitive.Overlay
      data-slot="bottom-sheet-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-[rgba(0,0,0,0.32)] backdrop-blur-[3px] data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

function BottomSheetClose({ ...props }: React.ComponentProps<typeof DrawerPrimitive.Close>) {
  return <DrawerPrimitive.Close data-slot="bottom-sheet-close" {...props} />
}

function BottomSheetContent({
  children,
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Content>) {
  return (
    <BottomSheetPortal>
      <BottomSheetOverlay />
      <DrawerPrimitive.Content
        data-slot="bottom-sheet-content"
        className={cn(
          "group/bottom-sheet fixed inset-x-4 bottom-4 z-50 mx-auto flex h-auto max-w-[22rem] flex-col overflow-hidden rounded-[2rem] border border-marketing-border bg-[linear-gradient(180deg,rgba(17,28,23,0.82),rgba(9,15,12,0.7))] text-sm text-marketing-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_24px_90px_rgba(0,0,0,0.36)] outline-none backdrop-blur-[18px]",
          className
        )}
        {...props}
      >
        <div
          aria-hidden="true"
          data-slot="bottom-sheet-handle"
          className="mx-auto mt-3 mb-4 h-1.5 w-12 shrink-0 rounded-full bg-[rgba(255,255,255,0.14)]"
        />
        {children}
      </DrawerPrimitive.Content>
    </BottomSheetPortal>
  )
}

function BottomSheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Title>) {
  return (
    <DrawerPrimitive.Title
      data-slot="bottom-sheet-title"
      className={cn("font-heading text-base font-medium text-foreground", className)}
      {...props}
    />
  )
}

function BottomSheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Description>) {
  return (
    <DrawerPrimitive.Description
      data-slot="bottom-sheet-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  BottomSheet,
  BottomSheetClose,
  BottomSheetContent,
  BottomSheetDescription,
  BottomSheetOverlay,
  BottomSheetPortal,
  BottomSheetTitle,
}
