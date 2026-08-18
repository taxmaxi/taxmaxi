import { Link } from "@tanstack/react-router"
import { CreditCard, LibraryBig, LogOut, Settings, UserRound } from "lucide-react"
import { useState } from "react"

import { Button } from "#/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu"
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
          className="size-11 rounded-full"
          size="icon-lg"
          title={m["app.accountMenu.label"]()}
          variant="outline"
        >
          <UserRound />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuItem asChild>
          <Link preload="intent" to="/assets">
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
