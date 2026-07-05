import { createFileRoute } from "@tanstack/react-router"
import { useId } from "react"

import { LegalPageShell } from "#/components/legal-page-shell"
import { LegalSectionCard } from "#/components/legal-section-card"

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      {
        name: "robots",
        content: "noindex",
      },
    ],
  }),
  component: PrivacyComponent,
})

function PrivacyComponent() {
  const ids = {
    controller: useId(),
    general: useId(),
    website: useId(),
    cookies: useId(),
    app: useId(),
    processors: useId(),
    retention: useId(),
    rights: useId(),
    security: useId(),
    changes: useId(),
  }

  const tableOfContents = [
    { href: `#${ids.controller}`, label: "Name and Address of the Controller" },
    { href: `#${ids.general}`, label: "General Notes and Information on Data Processing" },
    { href: `#${ids.website}`, label: "Collection of Personal Data when Visiting our Website" },
    { href: `#${ids.cookies}`, label: "Cookies" },
    { href: `#${ids.app}`, label: "Collection of Personal Data when Using our App" },
    {
      href: `#${ids.processors}`,
      label: "Recipients and Processors / Third-Country Transfers",
    },
    { href: `#${ids.retention}`, label: "Storage Period and Deletion" },
    { href: `#${ids.rights}`, label: "Your Rights" },
    { href: `#${ids.security}`, label: "Data Security" },
    { href: `#${ids.changes}`, label: "Status of and Changes to this Privacy Notice" },
  ] as const

  return (
    <LegalPageShell
      description="We, TaxMaxi UG (haftungsbeschränkt), take the confidentiality and protection of your personal data very seriously. We process personal data in accordance with applicable data protection laws, in particular the GDPR, and this Privacy Notice."
      tableOfContents={tableOfContents}
      title="Privacy Notice"
    >
      <LegalSectionCard id={ids.controller} title="1. Name and Address of the Controller">
        <p>
          The controller within the meaning of the General Data Protection Regulation (GDPR) and
          other national data protection laws of the Member States as well as other data protection
          regulations is:
        </p>
        <div className="space-y-2">
          <p>
            <strong>TaxMaxi UG (haftungsbeschränkt)</strong>
          </p>
          <address>
            Belforter Str. 9
            <br />
            10405 Berlin
            <br />
            Germany
          </address>
          <p>Managing Director: Maximilian Ast</p>
          <p>
            <a href="mailto:team@taxmaxi.com">team@taxmaxi.com</a>
          </p>
        </div>
      </LegalSectionCard>

      <LegalSectionCard
        id={ids.general}
        title="2. General Notes and Information on Data Processing"
      >
        <p>
          We process personal data only to the extent necessary for providing and improving our
          website and SaaS application, for performing contracts with you, for complying with legal
          obligations, or where we have a legitimate interest and your interests or fundamental
          rights do not override such interests.
        </p>
        <p>
          Personal data means any information relating to an identified or identifiable natural
          person. Processing includes any operation performed on personal data such as collection,
          storage, use, disclosure or deletion.
        </p>
        <p>
          Legal bases under Art. 6(1) GDPR: (a) consent, (b) contract performance and
          pre‑contractual measures, (c) legal obligation, (f) legitimate interests.
        </p>
      </LegalSectionCard>

      <LegalSectionCard
        id={ids.website}
        title="3. Collection of Personal Data when Visiting our Website"
      >
        <h3>3.1 Informational Use</h3>
        <p>
          When you access our website, your browser automatically transmits data to our server/CDN.
          We process the following technically necessary data to display the website and ensure
          stability and security (Art. 6(1)(f) GDPR): IP address, date and time of the request, time
          zone difference to GMT, content of the request (specific page), access status/HTTP status
          code, amount of data transferred, referrer URL, browser type, operating system and
          interface, language and version of the browser software.
        </p>
        <h3>3.2 Analytics (PostHog)</h3>
        <p>
          We use PostHog to analyze usage of our website and product in order to improve
          functionality and user experience. The data processed may include pseudonymous
          identifiers, usage events, device and browser information, and truncated IP addresses.
          Legal basis: our legitimate interest in product analytics (Art. 6(1)(f) GDPR) or your
          consent where required (Art. 6(1)(a) GDPR).
        </p>
        <p>
          Further information:{" "}
          <a href="https://posthog.com/privacy" rel="noopener noreferrer" target="_blank">
            PostHog Privacy
          </a>
          .
        </p>
      </LegalSectionCard>

      <LegalSectionCard id={ids.cookies} title="4. Cookies">
        <h3>4.1 What are Cookies?</h3>
        <p>
          Cookies are small text files stored on your device by your browser. They are widely used
          to make websites work, or work more efficiently, as well as to provide information to site
          owners.
        </p>
        <h3>4.2 Use of Cookies</h3>
        <p>
          We avoid non-essential cookies. Where analytics or similar cookies are used, we rely on
          your consent (Art. 6(1)(a) GDPR). You can withdraw consent at any time via your browser
          settings and, where implemented, our consent tools. We do not use advertising or
          third‑party tracking cookies.
        </p>
      </LegalSectionCard>

      <LegalSectionCard id={ids.app} title="5. Collection of Personal Data when Using our App">
        <h3>5.1 Account and Service Data</h3>
        <p>
          If you create an account or use our SaaS, we process account data (e.g., name, email,
          authentication data), product usage data, wallet addresses you provide, transaction data
          imported from supported sources, report configuration, and billing‑related information
          necessary to perform the contract (Art. 6(1)(b) GDPR) and to comply with legal obligations
          (Art. 6(1)(c) GDPR).
        </p>
        <h3>5.2 Blockchain and Market Data Sources</h3>
        <p>
          To fetch and process crypto transaction and pricing data, we may use third‑party APIs such
          as Alchemy (RPC/access to EVM chain data), Etherscan (block explorer data), and CoinGecko
          (token prices and metadata). For this purpose, wallet addresses or transaction hashes you
          provide may be transmitted to these providers. Legal basis: contract performance (Art.
          6(1)(b) GDPR) and our legitimate interests in accurate data processing (Art. 6(1)(f)
          GDPR).
        </p>
        <h3>5.3 Report Generation and Storage</h3>
        <p>
          When you request a tax report, we generate report files (e.g., PDFs) and may store them in
          secure cloud storage. Legal basis: contract performance (Art. 6(1)(b) GDPR) and legal
          obligation for tax documentation where applicable (Art. 6(1)(c) GDPR).
        </p>
      </LegalSectionCard>

      <LegalSectionCard
        id={ids.processors}
        title="6. Recipients and Processors / Third-Country Transfers"
      >
        <p>
          We share personal data with service providers acting on our behalf only as necessary and
          subject to data processing agreements. Categories include: hosting/CDN and infrastructure,
          analytics, product telemetry, databases and storage, and customer support tools.
        </p>
        <ul>
          <li>
            Hosting/CDN: Cloudflare Pages/Workers (frontend delivery). Legal basis: Art. 6(1)(f)
            GDPR. Privacy:{" "}
            <a
              href="https://www.cloudflare.com/privacypolicy/"
              rel="noopener noreferrer"
              target="_blank"
            >
              Cloudflare Privacy
            </a>
            .
          </li>
          <li>
            Analytics: PostHog. Privacy:{" "}
            <a href="https://posthog.com/privacy" rel="noopener noreferrer" target="_blank">
              PostHog Privacy
            </a>
            .
          </li>
          <li>
            Data sources: Alchemy, Etherscan, CoinGecko to retrieve blockchain and pricing data.
            Privacy:{" "}
            <a
              href="https://www.alchemy.com/policies/privacy"
              rel="noopener noreferrer"
              target="_blank"
            >
              Alchemy
            </a>
            ,{" "}
            <a href="https://etherscan.io/privacyPolicy" rel="noopener noreferrer" target="_blank">
              Etherscan
            </a>
            ,{" "}
            <a
              href="https://www.coingecko.com/en/privacy"
              rel="noopener noreferrer"
              target="_blank"
            >
              CoinGecko
            </a>
            .
          </li>
          <li>
            Storage: Google Cloud Storage. Privacy:{" "}
            <a
              href="https://cloud.google.com/security/privacy"
              rel="noopener noreferrer"
              target="_blank"
            >
              Google Cloud Privacy
            </a>
            .
          </li>
        </ul>
        <p>
          Where recipients are located outside the EEA, we ensure an adequate level of protection,
          e.g., through adequacy decisions or EU Standard Contractual Clauses (Art. 46 GDPR).
        </p>
      </LegalSectionCard>

      <LegalSectionCard id={ids.retention} title="7. Storage Period and Deletion">
        <p>
          We retain personal data only as long as necessary for the purposes described above.
          Statutory retention and documentation obligations may require longer storage, in
          particular under commercial and tax laws (generally 6–10 years). Log and security data are
          typically retained for up to 12 months unless needed longer for security or legal
          purposes.
        </p>
      </LegalSectionCard>

      <LegalSectionCard id={ids.rights} title="8. Your Rights">
        <p>
          <strong>Right of access</strong>, <strong>rectification</strong>, <strong>erasure</strong>
          , <strong>restriction</strong>, <strong>data portability</strong>, and{" "}
          <strong>objection</strong>. Where processing is based on consent, you may withdraw consent
          at any time (Art. 7(3)).
        </p>
        <p>
          You also have the right to lodge a complaint with a supervisory authority. The authority
          responsible for Berlin is Berliner Beauftragte für Datenschutz und Informationsfreiheit,
          Friedrichstr. 219, 10969 Berlin.
        </p>
        <p>
          To exercise your rights, please contact us at{" "}
          <a href="mailto:team@taxmaxi.com">team@taxmaxi.com</a>.
        </p>
      </LegalSectionCard>

      <LegalSectionCard id={ids.security} title="9. Data Security">
        <p>
          We use TLS encryption for data in transit and implement appropriate technical and
          organizational measures to protect your data against accidental or unlawful destruction,
          loss, alteration, unauthorized disclosure, or access. Our measures are continuously
          improved in line with technological developments.
        </p>
      </LegalSectionCard>

      <LegalSectionCard id={ids.changes} title="10. Status of and Changes to this Privacy Notice">
        <p>
          This Privacy Notice may be updated from time to time due to technical developments or
          changes in legal requirements. Last modified: 11 September 2025.
        </p>
        <div className="space-y-1">
          <p>Maximilian Ast (Managing Director)</p>
          <p>Berlin</p>
        </div>
      </LegalSectionCard>
    </LegalPageShell>
  )
}
