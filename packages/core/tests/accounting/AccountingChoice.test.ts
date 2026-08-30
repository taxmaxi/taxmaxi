import { describe, expect, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import {
  AccountingChoice,
  AccountingMethodId,
  JurisdictionCode,
  TaxYear,
} from "../../src/accounting/index.ts"

const decodeChoice = Schema.decodeUnknownSync(AccountingChoice)

describe("AccountingChoice", () => {
  it("decodes append-only method and inventory-scope choices", () => {
    const shared = {
      jurisdiction: "DE",
      recordedAt: { epochMillis: 1_700_000_000_000 },
      actor: "principal:42",
      evidence: "tax interview",
    }

    const method = decodeChoice({
      ...shared,
      _tag: "accounting_method",
      id: "11111111-1111-4111-8111-111111111111",
      method: "fifo",
    })
    const scope = decodeChoice({
      ...shared,
      _tag: "inventory_scope",
      id: "22222222-2222-4222-8222-222222222222",
      scope: "per_custody_unit",
      supersedesChoiceId: "33333333-3333-4333-8333-333333333333",
    })

    expect(method).toMatchObject({
      method: AccountingMethodId.make("fifo"),
      jurisdiction: JurisdictionCode.make("DE"),
    })
    expect(scope).toMatchObject({
      scope: "per_custody_unit",
      supersedesChoiceId: "33333333-3333-4333-8333-333333333333",
    })
  })

  it("rejects blank audit fields and invalid tax years", () => {
    expect(() =>
      decodeChoice({
        _tag: "accounting_method",
        id: "11111111-1111-4111-8111-111111111111",
        jurisdiction: "DE",
        method: "fifo",
        recordedAt: { epochMillis: 1_700_000_000_000 },
        actor: " ",
        evidence: "tax interview",
      })
    ).toThrow()
    expect(() => TaxYear.make(0)).toThrow()
  })
})
