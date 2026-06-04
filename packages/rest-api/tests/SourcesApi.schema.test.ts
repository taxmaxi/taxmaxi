import { CexSourceRef, Source, SourceId } from "@my/core/source"
import { PrincipalId } from "@my/core/ownership"
import { Timestamp } from "@my/core/shared/values/Timestamp"
import { describe, expect, it } from "vitest"
import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import {
  SourceOverviewResponse,
  SourceReportSyncStatus,
  SourceReportTotals,
} from "../src/definitions/SourcesApi.ts"

describe("SourcesApi schemas", () => {
  it("encodes source overview responses returned by the report repository", () => {
    const source = Source.make({
      id: SourceId.make("11111111-1111-4111-8111-111111111111"),
      principalId: PrincipalId.make("22222222-2222-4222-8222-222222222222"),
      name: "Coinbase Source",
      providerKey: "coinbase",
      sourceRef: CexSourceRef.make({
        cexAccountId: "33333333-3333-4333-8333-333333333333",
      }),
      createdAt: Timestamp.make({ epochMillis: 0 }),
    })

    const overview = SourceOverviewResponse.make({
      source,
      latestSync: SourceReportSyncStatus.make({
        status: null,
        mode: null,
        queuedAt: null,
        startedAt: null,
        completedAt: null,
        lastSyncedAt: null,
        lastErrorMessage: null,
        importedRecords: null,
        normalizedRecords: null,
        failedRecords: null,
      }),
      totals: SourceReportTotals.make({
        transactionCount: 0,
        legCount: 0,
        assetCount: 0,
        fifoLotCount: 0,
        disposalCount: 0,
        incomeCount: 0,
        feeCount: 0,
        realizedGainLoss: "0",
        incomeTotal: "0",
        currency: null,
      }),
    })

    const encoded = Schema.encodeEither(SourceOverviewResponse)(overview)

    expect(Either.isRight(encoded)).toBe(true)
  })
})
