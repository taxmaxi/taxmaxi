import { Logo } from "#/components/logo"
import { ContentContainer } from "#/components/content-container"
import GermanyIcon from "#/components/ui/icons/countries/de.svg"
import EUIcon from "#/components/ui/icons/countries/eu.svg"
import { m } from "#/paraglide/messages"
import { Link } from "@tanstack/react-router"

export function Footer() {
  return (
    <footer className="relative w-full border-t border-[#2a3a35]/30 py-8">
      <ContentContainer width="xl">
        <div className="flex flex-col lg:flex-row items-center justify-between gap-8">
          <div className="flex flex-col items-center lg:items-start gap-2">
            <Logo theme="dark" size="small" />
            <p className="text-xs text-[#6b9484]">
              © {new Date().getFullYear()} TaxMaxi UG (haftungsbeschränkt)
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-6">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full overflow-hidden">
                <img src={GermanyIcon} alt="Germany" className="object-cover w-full h-full" />
              </div>
              <div>
                <p className="text-sm text-[#a3c4b5]">{m["footer.madeInGermany"]()}</p>
                <p className="text-xs text-[#6b9484]">Berlin</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full overflow-hidden">
                <img src={EUIcon} alt="European Union" className="object-cover w-full h-full" />
              </div>
              <div>
                <p className="text-sm text-[#a3c4b5]">{m["footer.gdprCompliant"]()}</p>
                <p className="text-xs text-[#6b9484]">{m["footer.euHosted"]()}</p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-6">
            <Link
              to="/imprint"
              className="text-sm text-[#6b9484] hover:text-[#8ab4a3] transition-colors"
            >
              {m["footer.imprint"]()}
            </Link>
            <Link
              to="/privacy"
              className="text-sm text-[#6b9484] hover:text-[#8ab4a3] transition-colors"
            >
              {m["footer.privacy"]()}
            </Link>
            <Link
              to="/terms"
              className="text-sm text-[#6b9484] hover:text-[#8ab4a3] transition-colors"
            >
              {m["footer.terms"]()}
            </Link>
            <a
              href="mailto:max@taxmaxi.com"
              className="text-sm text-[#6b9484] hover:text-[#8ab4a3] transition-colors"
            >
              {m["footer.contact"]()}
            </a>
          </div>
        </div>
      </ContentContainer>
    </footer>
  )
}
