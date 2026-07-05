import { createFileRoute } from "@tanstack/react-router"

import { LegalPageShell } from "#/components/legal-page-shell"
import { LegalSectionCard } from "#/components/legal-section-card"

export const Route = createFileRoute("/imprint")({
  component: RouteComponent,
})

function RouteComponent() {
  return (
    <LegalPageShell title="Imprint">
      <LegalSectionCard>
        <div className="space-y-3">
          <p>
            <strong>TaxMaxi UG (haftungsbeschränkt)</strong>
          </p>
          <address>
            c/o Ast/Onward2
            <br />
            Belforter Str. 9
            <br />
            10405 Berlin
            <br />
            Germany
          </address>
          <p>
            <a href="mailto:team@taxmaxi.com">team@taxmaxi.com</a>
          </p>
          <p>Managing Director: Maximilian Ast</p>
          <p>
            registered in the commercial register of the district court Berlin-Charlottenburg under
            HRB 279275 B.
          </p>
          <p>VAT-ID: DE458618254</p>
          <p>
            Responsible for the content according to § 18 Abs. 2 MStV: Managing Director Maximilian
            Ast, TaxMaxi UG (haftungsbeschränkt) Belforter Str. 9, 10405 Berlin Germany
          </p>
        </div>
      </LegalSectionCard>

      <LegalSectionCard title="2. Liability for Contents and Links">
        <p>
          We make every effort to ensure that all information and links provided on this website are
          accurate, complete, and up to date. All contents are created with due care and to the best
          of our knowledge. However, we cannot guarantee that all contents provided on this website
          are accurate, complete, and up to date.
        </p>
        <p>
          As a service provider, we are responsible for our own content on these pages in accordance
          with applicable law. Insofar as we refer to the websites of third parties by means of
          hyperlinks on our website, we cannot accept any liability for the ongoing topicality,
          correctness, and completeness of the linked content, as this content lies outside our area
          of responsibility and we have no influence on its future design.
        </p>
        <p>
          The legal information on this page as well as all questions and disputes in connection
          with the design of this website are subject to the laws of the Federal Republic of
          Germany.
        </p>
      </LegalSectionCard>

      <LegalSectionCard title="3. Copyright Notice">
        <p>
          The texts, images, photos, videos, graphics, or other content available on our website are
          subject to copyright protection. Any unauthorized use, in particular copying, editing or
          distribution, of these copyrighted contents is prohibited.
        </p>
        <p>
          If you intend to use this content or parts thereof, you must contact us in advance using
          the details above and obtain our consent.
        </p>
      </LegalSectionCard>

      <LegalSectionCard title="4. Data Protection">
        <p>
          You can find our privacy policy here:{" "}
          <a href="https://www.taxmaxi.com/privacy" rel="noopener noreferrer" target="_blank">
            https://www.taxmaxi.com/privacy
          </a>
        </p>
      </LegalSectionCard>
    </LegalPageShell>
  )
}
