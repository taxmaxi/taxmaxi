import { Link } from "@tanstack/react-router"
import TaxMaxiLogo from "#/components/ui/logos/logo-wordmark.svg"
import TaxMaxiLogoDark from "#/components/ui/logos/logo-wordmark-dark.svg"
import TaxMaxiIconLogo from "#/components/ui/logos/taxmaxi.svg"
import TaxMaxiIconLogoDark from "#/components/ui/logos/taxmaxi-dark.svg"
import { cn } from "#/lib/utils"

type LogoTheme = "light" | "dark"

export const Logo = ({
  theme,
  size = "large",
  iconOnly = false,
}: {
  theme?: LogoTheme
  size?: "small" | "large"
  iconOnly?: boolean
}) => {
  const className = cn("inline-block", size === "small" ? "h-10" : "h-14")

  const lightLogo = iconOnly ? TaxMaxiIconLogo : TaxMaxiLogo
  const darkLogo = iconOnly ? TaxMaxiIconLogoDark : TaxMaxiLogoDark

  if (theme) {
    return (
      <Link to="/" className={className}>
        <img
          src={theme === "dark" ? darkLogo : lightLogo}
          alt="TaxMaxi Logo"
          className="h-full w-auto object-contain"
        />
      </Link>
    )
  }

  return (
    <Link to="/" className={className}>
      <img
        src={lightLogo}
        alt="TaxMaxi Logo"
        className="h-full w-auto object-contain dark:hidden"
      />
      <img
        src={darkLogo}
        alt="TaxMaxi Logo"
        className="hidden h-full w-auto object-contain dark:block"
      />
    </Link>
  )
}
