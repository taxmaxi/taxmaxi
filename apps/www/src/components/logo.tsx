import { Link } from "@tanstack/react-router"
import TaxMaxiLogo from "#/components/ui/logos/logo-wordmark.svg"
import TaxMaxiLogoDark from "#/components/ui/logos/logo-wordmark-dark.svg"
import TaxMaxiIconLogo from "#/components/ui/logos/taxmaxi.svg"
import TaxMaxiIconLogoDark from "#/components/ui/logos/taxmaxi-dark.svg"
import { cn } from "#/lib/utils"

export const Logo = ({
  theme,
  size = "large",
  iconOnly = false,
}: {
  theme: string
  size?: "small" | "large"
  iconOnly?: boolean
}) => {
  const className = cn("inline-block", size === "small" ? "h-10" : "h-11")
  const image = iconOnly ? (
    <img
      src={theme === "dark" ? TaxMaxiIconLogoDark : TaxMaxiIconLogo}
      alt="TaxMaxi Logo"
      className="object-contain h-full w-auto"
    />
  ) : (
    <img
      src={theme === "dark" ? TaxMaxiLogoDark : TaxMaxiLogo}
      alt="TaxMaxi Logo"
      className="object-contain h-full w-auto"
    />
  )

  return (
    <Link to="/" className={className}>
      {image}
    </Link>
  )
}
