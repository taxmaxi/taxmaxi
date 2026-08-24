import { Link } from "@tanstack/react-router"
import { CreditCard, LibraryBig, LogOut, Menu, Settings } from "lucide-react"
import { useState } from "react"

import { Button } from "#/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu"
import { ASSET_CATALOG_OPENER_ID } from "#/lib/asset-catalog-focus"
import { m } from "#/paraglide/messages"

export function AccountMenu({ onLogout }: { readonly onLogout: () => Promise<void> }) {
  const [isLoggingOut, setIsLoggingOut] = useState(false)

  const handleLogout = async () => {
    if (isLoggingOut) return

    setIsLoggingOut(true)
    try {
      await onLogout()
    } catch {
      setIsLoggingOut(false)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={m["app.accountMenu.label"]()}
          className="relative h-9 rounded-full px-3 touch-manipulation before:absolute before:-inset-y-1 before:inset-x-0 before:content-['']"
          id={ASSET_CATALOG_OPENER_ID}
          title={m["app.accountMenu.label"]()}
          variant="outline"
        >
          <Menu data-icon="inline-start" />
          {m["app.accountMenu.label"]()}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuGroup>
          <DropdownMenuItem asChild>
            <Link mask={{ to: "/assets" }} preload="intent" to="/app/assets">
              <LibraryBig />
              {m["app.accountMenu.assets"]()}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link preload="intent" to="/app/billing">
              <CreditCard />
              {m["app.accountMenu.billing"]()}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link preload="intent" to="/app/settings">
              <Settings />
              {m["app.accountMenu.settings"]()}
            </Link>
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={isLoggingOut}
          onSelect={() => void handleLogout()}
          variant="destructive"
        >
          <LogOut />
          {isLoggingOut ? m["app.accountMenu.loggingOut"]() : m["app.accountMenu.logout"]()}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
