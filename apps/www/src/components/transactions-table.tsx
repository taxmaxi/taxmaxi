import {
  ArrowDownLeft,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ArrowUpRight,
  Bot,
  Calculator,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  FileSearch,
  History,
  Landmark,
  Search,
  ShieldCheck,
  UserRound,
  WalletCards,
  X,
} from "lucide-react"
import {
  AnimatePresence,
  animate as animateValue,
  motion,
  useMotionValue,
  useReducedMotion,
} from "motion/react"
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import useMeasure from "react-use-measure"

import {
  BottomSheet,
  BottomSheetContent,
  BottomSheetDescription,
  BottomSheetTitle,
} from "#/components/bottom-sheet"
import { Badge } from "#/components/ui/badge"
import { Button } from "#/components/ui/button"
import { Input } from "#/components/ui/input"
import { cn } from "#/lib/utils"

type MovementRole = "acquired" | "disposed" | "income" | "fee"
type TransactionType = "swap" | "income" | "transfer" | "sell" | "buy" | "fee"
type TaxTreatment = "Taxable" | "Non-taxable" | "Deductible"
type ClassificationActor = "system" | "user" | "admin"
type ClassificationAction = "assigned" | "changed" | "confirmed"
type MobileInspectorView = "overview" | "tax" | "source" | "classification"

type Movement = {
  id: string
  amount: string
  asset: string
  eurValue: number
  role: MovementRole
}

type ClassificationEvent = {
  id: string
  occurredAt: string
  actor: ClassificationActor
  action: ClassificationAction
  fromType?: string
  toType: string
  confidence?: number
  reason?: string
  matchedLayer?: string
  legalRuleSetVersion?: string
  note?: string
}

type Transaction = {
  id: string
  occurredAt: string
  type: TransactionType
  title: string
  source: string
  sourceKind: "exchange" | "wallet"
  sourceReference: string
  network?: string
  counterparty?: string
  externalReference: string
  priceSource: string
  treatment: TaxTreatment
  fiatValue: number
  proceeds?: number
  costBasis?: number
  gainLoss?: number
  movements: ReadonlyArray<Movement>
  needsReview?: boolean
  classificationTrail: ReadonlyArray<ClassificationEvent>
}

const curatedTransactions = [
  {
    id: "tx-swap",
    occurredAt: "2025-12-18T13:32:08.000Z",
    type: "swap",
    title: "Swapped SOL for USDC",
    source: "Phantom wallet",
    sourceKind: "wallet",
    sourceReference: "8JcF…Y2km",
    network: "Solana",
    counterparty: "Jupiter",
    externalReference: "5muv2h…A9B3cT6",
    priceSource: "CoinGecko · 18 Dec 2025, 13:32 UTC",
    treatment: "Taxable",
    fiatValue: 1159.44,
    proceeds: 1159.44,
    costBasis: 917.26,
    gainLoss: 242.18,
    movements: [
      { id: "swap-disposal", amount: "8.42", asset: "SOL", eurValue: 1159.44, role: "disposed" },
      {
        id: "swap-acquisition",
        amount: "1,258.30",
        asset: "USDC",
        eurValue: 1159.44,
        role: "acquired",
      },
      { id: "swap-fee", amount: "0.000015", asset: "SOL", eurValue: 0.0021, role: "fee" },
    ],
    classificationTrail: [
      {
        id: "swap-system",
        occurredAt: "2025-12-18T13:33:02.000Z",
        actor: "system",
        action: "assigned",
        toType: "swap",
        confidence: 0.98,
        reason: "A Jupiter route disposed SOL and acquired USDC in the same signature.",
        matchedLayer: "solana_protocol_mapping",
        legalRuleSetVersion: "de-2025.4",
      },
    ],
  },
  {
    id: "tx-income",
    occurredAt: "2025-11-04T08:12:41.000Z",
    type: "income",
    title: "Received staking reward",
    source: "Ledger Solana",
    sourceKind: "wallet",
    sourceReference: "D6qP…3nKz",
    network: "Solana",
    counterparty: "Stake account",
    externalReference: "3Jcvdk…P2hS4nR",
    priceSource: "CoinGecko · 4 Nov 2025, 08:12 UTC",
    treatment: "Taxable",
    fiatValue: 12.91,
    movements: [
      { id: "income-reward", amount: "0.084", asset: "SOL", eurValue: 12.91, role: "income" },
    ],
    needsReview: true,
    classificationTrail: [
      {
        id: "income-system",
        occurredAt: "2025-11-04T08:13:19.000Z",
        actor: "system",
        action: "assigned",
        toType: "staking_reward",
        confidence: 0.76,
        reason: "Funds originated from a stake account, but the reward instruction was incomplete.",
        matchedLayer: "solana_activity_classifier",
        legalRuleSetVersion: "de-2025.4",
      },
    ],
  },
  {
    id: "tx-transfer",
    occurredAt: "2025-10-26T20:45:17.000Z",
    type: "transfer",
    title: "Sent USDC to Coinbase",
    source: "Phantom wallet",
    sourceKind: "wallet",
    sourceReference: "8JcF…Y2km",
    network: "Solana",
    counterparty: "Coinbase",
    externalReference: "2kmJQ7…P4zXvLp",
    priceSource: "CoinGecko · 26 Oct 2025, 20:45 UTC",
    treatment: "Non-taxable",
    fiatValue: 462.33,
    movements: [
      {
        id: "transfer-disposal",
        amount: "500.00",
        asset: "USDC",
        eurValue: 462.33,
        role: "disposed",
      },
    ],
    classificationTrail: [
      {
        id: "transfer-system",
        occurredAt: "2025-10-26T20:46:03.000Z",
        actor: "system",
        action: "assigned",
        toType: "sell",
        confidence: 0.63,
        reason: "USDC left the wallet and no linked destination source was available.",
        matchedLayer: "asset_movement_fallback",
        legalRuleSetVersion: "de-2025.3",
      },
      {
        id: "transfer-admin",
        occurredAt: "2025-10-27T09:18:00.000Z",
        actor: "admin",
        action: "changed",
        fromType: "sell",
        toType: "transfer",
        note: "Matched the destination address to the connected Coinbase account.",
      },
    ],
  },
  {
    id: "tx-sell",
    occurredAt: "2025-09-15T16:03:29.000Z",
    type: "sell",
    title: "Sold ETH for EUR",
    source: "Kraken",
    sourceKind: "exchange",
    sourceReference: "Kraken · •• 4182",
    counterparty: "ETH–EUR market",
    externalReference: "kraken-ledger-932187",
    priceSource: "Kraken execution price",
    treatment: "Taxable",
    fiatValue: 1038.72,
    proceeds: 1038.72,
    costBasis: 1125.26,
    gainLoss: -86.54,
    movements: [
      { id: "sell-disposal", amount: "0.35", asset: "ETH", eurValue: 1038.72, role: "disposed" },
    ],
    classificationTrail: [
      {
        id: "sell-system",
        occurredAt: "2025-09-15T16:04:06.000Z",
        actor: "system",
        action: "assigned",
        toType: "transfer",
        confidence: 0.61,
        reason: "The provider payload contained an outbound ETH leg without a normalized fiat leg.",
        matchedLayer: "provider_asset_mapping",
        legalRuleSetVersion: "de-2025.3",
      },
      {
        id: "sell-user",
        occurredAt: "2025-09-16T07:42:00.000Z",
        actor: "user",
        action: "changed",
        fromType: "transfer",
        toType: "sell",
        note: "I sold this ETH on Kraken and received EUR in the same account.",
      },
    ],
  },
  {
    id: "tx-buy",
    occurredAt: "2025-03-11T06:54:36.000Z",
    type: "buy",
    title: "Bought BTC with EUR",
    source: "Bitstamp",
    sourceKind: "exchange",
    sourceReference: "Bitstamp · •• 7004",
    counterparty: "BTC–EUR market",
    externalReference: "bitstamp-trade-8817234",
    priceSource: "Bitstamp execution price",
    treatment: "Non-taxable",
    fiatValue: 119842.1,
    costBasis: 119842.1,
    movements: [
      { id: "buy-acquisition", amount: "1.85", asset: "BTC", eurValue: 119842.1, role: "acquired" },
    ],
    classificationTrail: [
      {
        id: "buy-system",
        occurredAt: "2025-03-11T06:55:01.000Z",
        actor: "system",
        action: "assigned",
        toType: "buy",
        confidence: 0.99,
        reason: "The Bitstamp trade paired an EUR disposal with a BTC acquisition.",
        matchedLayer: "provider_transaction_mapping",
        legalRuleSetVersion: "de-2025.1",
      },
      {
        id: "buy-user",
        occurredAt: "2025-03-11T07:10:00.000Z",
        actor: "user",
        action: "confirmed",
        toType: "buy",
        note: "Classification confirmed.",
      },
    ],
  },
  {
    id: "tx-fee",
    occurredAt: "2024-12-22T22:08:14.000Z",
    type: "fee",
    title: "Closed token account",
    source: "Phantom wallet",
    sourceKind: "wallet",
    sourceReference: "8JcF…Y2km",
    network: "Solana",
    counterparty: "System program",
    externalReference: "7Gcxtb…5aRz8",
    priceSource: "CoinGecko · 22 Dec 2024, 22:08 UTC",
    treatment: "Deductible",
    fiatValue: 0.004,
    movements: [
      { id: "fee-network", amount: "0.000022", asset: "SOL", eurValue: 0.004, role: "fee" },
    ],
    classificationTrail: [
      {
        id: "fee-system",
        occurredAt: "2024-12-22T22:08:47.000Z",
        actor: "system",
        action: "assigned",
        toType: "fee",
        confidence: 1,
        reason: "The SOL movement paid for a token-account close instruction.",
        matchedLayer: "solana_instruction_mapping",
        legalRuleSetVersion: "de-2024.4",
      },
    ],
  },
] satisfies ReadonlyArray<Transaction>

type PrototypeTransactionProfile = {
  occurredAt: string
  type: TransactionType
  title: string
  source: string
  sourceKind: Transaction["sourceKind"]
  sourceReference: string
  network?: string
  counterparty: string
  asset: string
  counterAsset?: string
  amount: string
  fiatValue: number
  gainLoss?: number
  treatment: TaxTreatment
  needsReview?: boolean
}

const prototypeTransactionProfiles = [
  {
    occurredAt: "2025-12-16T10:14:22.000Z",
    type: "buy",
    title: "Bought ETH with EUR",
    source: "Coinbase",
    sourceKind: "exchange",
    sourceReference: "Coinbase · •• 2194",
    counterparty: "ETH–EUR market",
    asset: "ETH",
    amount: "0.42",
    fiatValue: 1248.72,
    treatment: "Non-taxable",
  },
  {
    occurredAt: "2025-12-12T18:42:11.000Z",
    type: "sell",
    title: "Sold BTC for EUR",
    source: "Coinbase",
    sourceKind: "exchange",
    sourceReference: "Coinbase · •• 2194",
    counterparty: "BTC–EUR market",
    asset: "BTC",
    amount: "0.018",
    fiatValue: 1634.18,
    gainLoss: 311.42,
    treatment: "Taxable",
  },
  {
    occurredAt: "2025-12-08T06:05:47.000Z",
    type: "transfer",
    title: "Moved SOL to Ledger",
    source: "Phantom wallet",
    sourceKind: "wallet",
    sourceReference: "8JcF…Y2km",
    network: "Solana",
    counterparty: "Ledger Solana",
    asset: "SOL",
    amount: "12.5",
    fiatValue: 1742.63,
    treatment: "Non-taxable",
  },
  {
    occurredAt: "2025-12-02T12:32:05.000Z",
    type: "income",
    title: "Received validator reward",
    source: "Ledger Solana",
    sourceKind: "wallet",
    sourceReference: "D6qP…3nKz",
    network: "Solana",
    counterparty: "Stake account",
    asset: "SOL",
    amount: "0.091",
    fiatValue: 13.66,
    treatment: "Taxable",
  },
  {
    occurredAt: "2025-11-28T21:10:19.000Z",
    type: "swap",
    title: "Swapped USDC for SOL",
    source: "Phantom wallet",
    sourceKind: "wallet",
    sourceReference: "8JcF…Y2km",
    network: "Solana",
    counterparty: "Jupiter",
    asset: "USDC",
    counterAsset: "SOL",
    amount: "750.00",
    fiatValue: 691.35,
    gainLoss: 4.86,
    treatment: "Taxable",
  },
  {
    occurredAt: "2025-11-21T09:23:52.000Z",
    type: "fee",
    title: "Paid withdrawal fee",
    source: "Kraken",
    sourceKind: "exchange",
    sourceReference: "Kraken · •• 4182",
    counterparty: "Kraken",
    asset: "ETH",
    amount: "0.003",
    fiatValue: 8.91,
    treatment: "Deductible",
  },
  {
    occurredAt: "2025-11-13T14:57:33.000Z",
    type: "buy",
    title: "Bought SOL with EUR",
    source: "Bitstamp",
    sourceKind: "exchange",
    sourceReference: "Bitstamp · •• 7004",
    counterparty: "SOL–EUR market",
    asset: "SOL",
    amount: "18.4",
    fiatValue: 2715.08,
    treatment: "Non-taxable",
  },
  {
    occurredAt: "2025-10-31T23:14:18.000Z",
    type: "swap",
    title: "Swapped ETH for USDC",
    source: "MetaMask",
    sourceKind: "wallet",
    sourceReference: "0x71d…90a2",
    network: "Ethereum",
    counterparty: "Uniswap",
    asset: "ETH",
    counterAsset: "USDC",
    amount: "0.75",
    fiatValue: 2268.4,
    gainLoss: -112.08,
    treatment: "Taxable",
    needsReview: true,
  },
  {
    occurredAt: "2025-10-18T17:38:02.000Z",
    type: "income",
    title: "Received Coinbase reward",
    source: "Coinbase",
    sourceKind: "exchange",
    sourceReference: "Coinbase · •• 2194",
    counterparty: "Coinbase Earn",
    asset: "USDC",
    amount: "18.00",
    fiatValue: 16.61,
    treatment: "Taxable",
  },
  {
    occurredAt: "2025-10-04T08:41:36.000Z",
    type: "transfer",
    title: "Moved BTC to cold storage",
    source: "Kraken",
    sourceKind: "exchange",
    sourceReference: "Kraken · •• 4182",
    network: "Bitcoin",
    counterparty: "Ledger Bitcoin",
    asset: "BTC",
    amount: "0.12",
    fiatValue: 10526.22,
    treatment: "Non-taxable",
  },
  {
    occurredAt: "2025-09-29T13:26:44.000Z",
    type: "sell",
    title: "Sold SOL for EUR",
    source: "Kraken",
    sourceKind: "exchange",
    sourceReference: "Kraken · •• 4182",
    counterparty: "SOL–EUR market",
    asset: "SOL",
    amount: "24.2",
    fiatValue: 3548.91,
    gainLoss: 892.17,
    treatment: "Taxable",
  },
  {
    occurredAt: "2025-09-02T19:08:27.000Z",
    type: "fee",
    title: "Paid Ethereum network fee",
    source: "MetaMask",
    sourceKind: "wallet",
    sourceReference: "0x71d…90a2",
    network: "Ethereum",
    counterparty: "Ethereum network",
    asset: "ETH",
    amount: "0.0018",
    fiatValue: 5.43,
    treatment: "Deductible",
  },
  {
    occurredAt: "2025-08-27T07:52:16.000Z",
    type: "buy",
    title: "Bought BTC with EUR",
    source: "Coinbase",
    sourceKind: "exchange",
    sourceReference: "Coinbase · •• 2194",
    counterparty: "BTC–EUR market",
    asset: "BTC",
    amount: "0.035",
    fiatValue: 3021.66,
    treatment: "Non-taxable",
  },
  {
    occurredAt: "2025-08-14T11:39:08.000Z",
    type: "income",
    title: "Received staking reward",
    source: "Coinbase",
    sourceKind: "exchange",
    sourceReference: "Coinbase · •• 2194",
    counterparty: "Coinbase staking",
    asset: "ETH",
    amount: "0.0068",
    fiatValue: 20.12,
    treatment: "Taxable",
  },
  {
    occurredAt: "2025-07-30T16:44:51.000Z",
    type: "transfer",
    title: "Received ETH from MetaMask",
    source: "Kraken",
    sourceKind: "exchange",
    sourceReference: "Kraken · •• 4182",
    network: "Ethereum",
    counterparty: "MetaMask",
    asset: "ETH",
    amount: "1.25",
    fiatValue: 3678.88,
    treatment: "Non-taxable",
  },
  {
    occurredAt: "2025-07-18T22:17:09.000Z",
    type: "swap",
    title: "Swapped SOL for JUP",
    source: "Phantom wallet",
    sourceKind: "wallet",
    sourceReference: "8JcF…Y2km",
    network: "Solana",
    counterparty: "Jupiter",
    asset: "SOL",
    counterAsset: "JUP",
    amount: "6.4",
    fiatValue: 916.32,
    gainLoss: 204.61,
    treatment: "Taxable",
  },
  {
    occurredAt: "2025-06-24T05:51:42.000Z",
    type: "sell",
    title: "Sold ETH for EUR",
    source: "Bitstamp",
    sourceKind: "exchange",
    sourceReference: "Bitstamp · •• 7004",
    counterparty: "ETH–EUR market",
    asset: "ETH",
    amount: "0.9",
    fiatValue: 2541.73,
    gainLoss: 418.09,
    treatment: "Taxable",
  },
  {
    occurredAt: "2025-06-07T15:12:04.000Z",
    type: "buy",
    title: "Bought ETH with EUR",
    source: "Kraken",
    sourceKind: "exchange",
    sourceReference: "Kraken · •• 4182",
    counterparty: "ETH–EUR market",
    asset: "ETH",
    amount: "1.1",
    fiatValue: 3077.58,
    treatment: "Non-taxable",
  },
  {
    occurredAt: "2025-05-19T10:02:31.000Z",
    type: "income",
    title: "Received referral reward",
    source: "Bitstamp",
    sourceKind: "exchange",
    sourceReference: "Bitstamp · •• 7004",
    counterparty: "Bitstamp rewards",
    asset: "EUR",
    amount: "25.00",
    fiatValue: 25,
    treatment: "Taxable",
  },
  {
    occurredAt: "2025-05-01T12:48:55.000Z",
    type: "transfer",
    title: "Moved USDC to Phantom",
    source: "Coinbase",
    sourceKind: "exchange",
    sourceReference: "Coinbase · •• 2194",
    network: "Solana",
    counterparty: "Phantom wallet",
    asset: "USDC",
    amount: "1,500.00",
    fiatValue: 1384.27,
    treatment: "Non-taxable",
  },
  {
    occurredAt: "2025-04-16T18:29:13.000Z",
    type: "fee",
    title: "Paid custody fee",
    source: "Coinbase",
    sourceKind: "exchange",
    sourceReference: "Coinbase · •• 2194",
    counterparty: "Coinbase",
    asset: "USDC",
    amount: "3.00",
    fiatValue: 2.77,
    treatment: "Deductible",
  },
  {
    occurredAt: "2025-03-28T09:07:39.000Z",
    type: "swap",
    title: "Swapped USDC for ETH",
    source: "MetaMask",
    sourceKind: "wallet",
    sourceReference: "0x71d…90a2",
    network: "Ethereum",
    counterparty: "Uniswap",
    asset: "USDC",
    counterAsset: "ETH",
    amount: "2,000.00",
    fiatValue: 1847.9,
    gainLoss: 18.22,
    treatment: "Taxable",
  },
  {
    occurredAt: "2025-02-14T20:36:48.000Z",
    type: "sell",
    title: "Sold BTC for EUR",
    source: "Bitstamp",
    sourceKind: "exchange",
    sourceReference: "Bitstamp · •• 7004",
    counterparty: "BTC–EUR market",
    asset: "BTC",
    amount: "0.044",
    fiatValue: 3680.44,
    gainLoss: -226.31,
    treatment: "Taxable",
  },
  {
    occurredAt: "2025-01-26T07:15:20.000Z",
    type: "transfer",
    title: "Moved ETH to MetaMask",
    source: "Coinbase",
    sourceKind: "exchange",
    sourceReference: "Coinbase · •• 2194",
    network: "Ethereum",
    counterparty: "MetaMask",
    asset: "ETH",
    amount: "0.8",
    fiatValue: 2382.16,
    treatment: "Non-taxable",
  },
] satisfies ReadonlyArray<PrototypeTransactionProfile>

const generatedTransactions = prototypeTransactionProfiles.map<Transaction>((profile, index) => {
  const isAcquisition = profile.type === "buy" || profile.type === "income"
  const movementRole: MovementRole =
    profile.type === "fee"
      ? "fee"
      : isAcquisition
        ? profile.type === "income"
          ? "income"
          : "acquired"
        : "disposed"
  const costBasis =
    profile.gainLoss === undefined ? undefined : profile.fiatValue - profile.gainLoss
  const transactionId = `tx-prototype-${index + 1}`
  const movements: ReadonlyArray<Movement> = [
    {
      id: `${transactionId}-primary`,
      amount: profile.amount,
      asset: profile.asset,
      eurValue: profile.fiatValue,
      role: movementRole,
    },
    ...(profile.counterAsset === undefined
      ? []
      : [
          {
            id: `${transactionId}-counter`,
            amount: (profile.fiatValue / 100).toLocaleString("en-GB", {
              maximumFractionDigits: 3,
            }),
            asset: profile.counterAsset,
            eurValue: profile.fiatValue,
            role: "acquired" as const,
          },
          {
            id: `${transactionId}-fee`,
            amount: "0.000021",
            asset: profile.network === "Ethereum" ? "ETH" : "SOL",
            eurValue: profile.network === "Ethereum" ? 4.62 : 0.003,
            role: "fee" as const,
          },
        ]),
  ]

  return {
    id: transactionId,
    occurredAt: profile.occurredAt,
    type: profile.type,
    title: profile.title,
    source: profile.source,
    sourceKind: profile.sourceKind,
    sourceReference: profile.sourceReference,
    network: profile.network,
    counterparty: profile.counterparty,
    externalReference: `prototype-reference-${String(index + 1).padStart(4, "0")}`,
    priceSource:
      profile.sourceKind === "exchange"
        ? `${profile.source} execution price`
        : "CoinGecko historical market price",
    treatment: profile.treatment,
    fiatValue: profile.fiatValue,
    proceeds: profile.gainLoss === undefined ? undefined : profile.fiatValue,
    costBasis,
    gainLoss: profile.gainLoss,
    movements,
    needsReview: profile.needsReview,
    classificationTrail: [
      {
        id: `${transactionId}-system`,
        occurredAt: profile.occurredAt,
        actor: "system",
        action: "assigned",
        toType: profile.type,
        confidence: profile.needsReview === true ? 0.68 : 0.96,
        reason: `Provider evidence and linked asset movements matched this ${typeLabel(profile.type)}.`,
        matchedLayer:
          profile.sourceKind === "exchange"
            ? "provider_transaction_mapping"
            : "wallet_activity_classifier",
        legalRuleSetVersion: "de-2025.4",
      },
    ],
  }
})

const transactions: ReadonlyArray<Transaction> = [
  ...curatedTransactions,
  ...generatedTransactions,
].sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt))

const PAGE_SIZE = 7

const currencyFormatter = new Intl.NumberFormat("de-DE", {
  currency: "EUR",
  style: "currency",
})

const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
})

const dateTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  month: "short",
  year: "numeric",
})

const timeFormatter = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
})

function formatCurrency(value: number) {
  return currencyFormatter.format(value)
}

function formatDate(value: string) {
  return dateFormatter.format(new Date(value))
}

function formatTime(value: string) {
  return timeFormatter.format(new Date(value))
}

function formatDateTime(value: string) {
  return dateTimeFormatter.format(new Date(value))
}

function formatGainLoss(value: number) {
  const sign = value > 0 ? "+" : value < 0 ? "−" : ""
  return `${sign}${formatCurrency(Math.abs(value))}`
}

function typeLabel(type: string) {
  const words = type.replaceAll("_", " ").replaceAll("-", " ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function roleLabel(role: MovementRole) {
  switch (role) {
    case "acquired":
      return "Acquired"
    case "disposed":
      return "Disposed"
    case "income":
      return "Income"
    case "fee":
      return "Fee"
  }
}

function RoleIcon({ role }: { role: MovementRole }) {
  switch (role) {
    case "acquired":
    case "income":
      return <ArrowDownLeft className="size-4" />
    case "disposed":
    case "fee":
      return <ArrowUpRight className="size-4" />
  }
}

function SourceIcon({ kind }: { kind: Transaction["sourceKind"] }) {
  return kind === "wallet" ? <WalletCards className="size-4" /> : <Landmark className="size-4" />
}

function GainLoss({ transaction }: { transaction: Transaction }) {
  if (transaction.gainLoss === undefined) {
    return (
      <div className="text-right">
        <div className="text-muted-foreground">—</div>
        <div className="text-xs text-muted-foreground">{transaction.treatment}</div>
      </div>
    )
  }

  return (
    <div className="text-right">
      <div
        className={cn(
          "font-semibold tabular-nums",
          transaction.gainLoss >= 0 ? "text-emerald-700 dark:text-emerald-300" : "text-destructive"
        )}
      >
        {formatGainLoss(transaction.gainLoss)}
      </div>
      <div className="text-xs text-muted-foreground">Realized</div>
    </div>
  )
}

function CompactGainLoss({ transaction }: { transaction: Transaction }) {
  if (transaction.gainLoss === undefined) {
    return <span className="text-xs text-muted-foreground">{transaction.treatment}</span>
  }

  return (
    <span
      className={cn(
        "text-xs font-semibold tabular-nums",
        transaction.gainLoss >= 0 ? "text-emerald-700 dark:text-emerald-300" : "text-destructive"
      )}
    >
      {formatGainLoss(transaction.gainLoss)}
    </span>
  )
}

export function TransactionsTable() {
  const [selectedId, setSelectedId] = useState(transactions[0]?.id ?? "")
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(1)
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false)
  const filteredTransactions = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (query.length === 0) {
      return transactions
    }

    return transactions.filter((transaction) =>
      [
        transaction.title,
        transaction.source,
        transaction.type,
        transaction.counterparty,
        transaction.externalReference,
        ...transaction.movements.map((movement) => movement.asset),
      ]
        .filter((value) => value !== undefined)
        .some((value) => value.toLowerCase().includes(query))
    )
  }, [search])

  const pageCount = Math.max(1, Math.ceil(filteredTransactions.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount)
  const pageStart = (currentPage - 1) * PAGE_SIZE
  const pageTransactions = filteredTransactions.slice(pageStart, pageStart + PAGE_SIZE)
  const selectedTransaction =
    filteredTransactions.find((transaction) => transaction.id === selectedId) ??
    filteredTransactions[0]
  const selectedIndex =
    selectedTransaction === undefined
      ? -1
      : filteredTransactions.findIndex((transaction) => transaction.id === selectedTransaction.id)

  useEffect(() => {
    if (page > pageCount) {
      setPage(pageCount)
    }
  }, [page, pageCount])

  function selectTransaction(transaction: Transaction) {
    setSelectedId(transaction.id)

    if (window.matchMedia("(max-width: 1023px)").matches) {
      setMobileSheetOpen(true)
    }
  }

  function goToPage(nextPage: number) {
    const boundedPage = Math.min(Math.max(nextPage, 1), pageCount)
    setPage(boundedPage)

    const nextTransaction = filteredTransactions[(boundedPage - 1) * PAGE_SIZE]
    if (nextTransaction !== undefined) {
      setSelectedId(nextTransaction.id)
    }
  }

  function navigateTransaction(direction: -1 | 1) {
    const nextIndex = selectedIndex + direction
    const nextTransaction = filteredTransactions[nextIndex]

    if (nextTransaction === undefined) {
      return
    }

    setSelectedId(nextTransaction.id)
    setPage(Math.floor(nextIndex / PAGE_SIZE) + 1)
  }

  const visibleStart = filteredTransactions.length === 0 ? 0 : pageStart + 1
  const visibleEnd = Math.min(pageStart + PAGE_SIZE, filteredTransactions.length)

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Transaction activity
          </p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight">Transactions</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Select a transaction to inspect its asset movements, tax calculation, source evidence,
            and classification history.
          </p>
        </div>
        <Badge className="w-fit" variant="secondary">
          {transactions.length} transactions
        </Badge>
      </div>

      <div className="grid min-h-[38rem] overflow-hidden rounded-xl border bg-background shadow-sm lg:grid-cols-[minmax(0,1.25fr)_minmax(23rem,0.75fr)]">
        <div className="flex min-w-0 flex-col border-b lg:border-r lg:border-b-0">
          <div className="border-b p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label="Search transactions"
                className="pl-9"
                onChange={(event) => {
                  setSearch(event.target.value)
                  setPage(1)
                }}
                placeholder="Search asset, source, type, or reference"
                value={search}
              />
            </div>
          </div>

          <div className="flex-1 divide-y">
            {filteredTransactions.length === 0 ? (
              <div className="flex min-h-40 items-center justify-center px-4 text-sm text-muted-foreground">
                No transactions match your search.
              </div>
            ) : (
              pageTransactions.map((transaction) => (
                <button
                  aria-pressed={selectedTransaction?.id === transaction.id}
                  className={cn(
                    "grid min-h-20 w-full grid-cols-[4.75rem_minmax(0,1fr)] items-center gap-3 px-3 py-3.5 text-left transition-colors sm:grid-cols-[7rem_minmax(0,1fr)_auto] sm:px-4 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-muted/50",
                    selectedTransaction?.id === transaction.id && "bg-muted"
                  )}
                  key={transaction.id}
                  onClick={() => selectTransaction(transaction)}
                  type="button"
                >
                  <div>
                    <div className="text-sm font-medium tabular-nums">
                      {formatDate(transaction.occurredAt)}
                    </div>
                    <div className="text-xs tabular-nums text-muted-foreground">
                      {formatTime(transaction.occurredAt)}
                    </div>
                  </div>
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <Badge className="shrink-0" variant="outline">
                        {typeLabel(transaction.type)}
                      </Badge>
                      <span className="truncate font-medium">{transaction.title}</span>
                      {transaction.needsReview === true ? (
                        <CircleAlert
                          aria-label="Needs review"
                          className="size-4 shrink-0 text-amber-600 dark:text-amber-300"
                        />
                      ) : null}
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground">
                        <SourceIcon kind={transaction.sourceKind} /> {transaction.source}
                      </span>
                      <span className="shrink-0 sm:hidden">
                        <CompactGainLoss transaction={transaction} />
                      </span>
                    </div>
                  </div>
                  <div className="hidden min-w-24 sm:block">
                    <GainLoss transaction={transaction} />
                  </div>
                </button>
              ))
            )}
          </div>

          <Pagination
            currentPage={currentPage}
            onPageChange={goToPage}
            pageCount={pageCount}
            total={filteredTransactions.length}
            visibleEnd={visibleEnd}
            visibleStart={visibleStart}
          />
        </div>

        <div className="hidden lg:block">
          <TransactionInspector transaction={selectedTransaction} />
        </div>
      </div>

      <TransactionMobileSheet
        canGoNext={selectedIndex >= 0 && selectedIndex < filteredTransactions.length - 1}
        canGoPrevious={selectedIndex > 0}
        currentPosition={selectedIndex + 1}
        onNavigate={navigateTransaction}
        onOpenChange={setMobileSheetOpen}
        open={mobileSheetOpen}
        total={filteredTransactions.length}
        transaction={selectedTransaction}
      />
    </div>
  )
}

function Pagination({
  currentPage,
  onPageChange,
  pageCount,
  total,
  visibleEnd,
  visibleStart,
}: {
  currentPage: number
  onPageChange: (page: number) => void
  pageCount: number
  total: number
  visibleEnd: number
  visibleStart: number
}) {
  if (total === 0) {
    return null
  }

  return (
    <nav
      aria-label="Transaction pages"
      className="flex items-center justify-between gap-3 border-t bg-muted/20 px-3 py-3 sm:px-4"
    >
      <p className="text-xs tabular-nums text-muted-foreground">
        {visibleStart}–{visibleEnd} of {total}
      </p>

      <div className="flex items-center gap-1">
        <Button
          aria-label="Previous page"
          disabled={currentPage === 1}
          onClick={() => onPageChange(currentPage - 1)}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <ChevronLeft />
        </Button>

        <div className="hidden items-center gap-1 sm:flex">
          {Array.from({ length: pageCount }, (_, index) => index + 1).map((pageNumber) => (
            <Button
              aria-current={currentPage === pageNumber ? "page" : undefined}
              className="tabular-nums"
              key={pageNumber}
              onClick={() => onPageChange(pageNumber)}
              size="icon-sm"
              type="button"
              variant={currentPage === pageNumber ? "secondary" : "ghost"}
            >
              {pageNumber}
            </Button>
          ))}
        </div>

        <span className="px-2 text-xs font-medium tabular-nums sm:hidden">
          {currentPage} / {pageCount}
        </span>

        <Button
          aria-label="Next page"
          disabled={currentPage === pageCount}
          onClick={() => onPageChange(currentPage + 1)}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <ChevronRight />
        </Button>
      </div>
    </nav>
  )
}

function TransactionMobileSheet({
  canGoNext,
  canGoPrevious,
  currentPosition,
  onNavigate,
  onOpenChange,
  open,
  total,
  transaction,
}: {
  canGoNext: boolean
  canGoPrevious: boolean
  currentPosition: number
  onNavigate: (direction: -1 | 1) => void
  onOpenChange: (open: boolean) => void
  open: boolean
  total: number
  transaction: Transaction | undefined
}) {
  const [view, setView] = useState<MobileInspectorView>("overview")
  const [direction, setDirection] = useState<1 | -1>(1)
  const [contentRef, bounds] = useMeasure()
  const animatedHeight = useMotionValue(0)
  const hasMeasuredHeightRef = useRef(false)
  const previousHeightRef = useRef<number | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const reduceMotion = useReducedMotion()

  useEffect(() => {
    if (!open) {
      animatedHeight.set(0)
      hasMeasuredHeightRef.current = false
      setView("overview")
      setDirection(1)
      previousHeightRef.current = null
    }
  }, [animatedHeight, open])

  useEffect(() => {
    if (bounds.height === 0) {
      return
    }

    if (!hasMeasuredHeightRef.current) {
      animatedHeight.set(bounds.height)
      hasMeasuredHeightRef.current = true
      return
    }

    if (reduceMotion === true) {
      animatedHeight.set(bounds.height)
      return
    }

    const controls = animateValue(animatedHeight, bounds.height, {
      duration: 0.24,
      ease: [0.25, 1, 0.5, 1],
    })

    return () => controls.stop()
  }, [animatedHeight, bounds.height, reduceMotion])

  const opacityDuration = useMemo(() => {
    const previousHeight = previousHeightRef.current
    const currentHeight = bounds.height
    const minimumDuration = 0.15
    const maximumDuration = 0.27

    if (previousHeight === null) {
      previousHeightRef.current = currentHeight
      return minimumDuration
    }

    const heightDifference = Math.abs(currentHeight - previousHeight)
    previousHeightRef.current = currentHeight

    return Math.min(Math.max(heightDifference / 500, minimumDuration), maximumDuration)
  }, [bounds.height])

  function openView(nextView: Exclude<MobileInspectorView, "overview">) {
    if (scrollContainerRef.current !== null) {
      scrollContainerRef.current.scrollTop = 0
    }
    setDirection(1)
    setView(nextView)
  }

  function goBack() {
    if (scrollContainerRef.current !== null) {
      scrollContainerRef.current.scrollTop = 0
    }
    setDirection(-1)
    setView("overview")
  }

  return (
    <BottomSheet open={open} onOpenChange={onOpenChange} shouldScaleBackground={false}>
      <BottomSheetContent
        className="inset-x-2 bottom-2 max-w-xl overflow-clip border-border bg-popover text-foreground shadow-2xl lg:hidden [&>[data-slot=bottom-sheet-handle]]:mt-2 [&>[data-slot=bottom-sheet-handle]]:mb-2"
        data-transaction-mobile-sheet=""
        style={{ backgroundImage: "none" }}
      >
        <motion.div style={{ height: hasMeasuredHeightRef.current ? animatedHeight : "auto" }}>
          <BottomSheetTitle className="sr-only">Transaction details</BottomSheetTitle>
          <BottomSheetDescription className="sr-only">
            Inspect this transaction and move to the previous or next transaction without closing
            the sheet.
          </BottomSheetDescription>

          <div
            className="max-h-[calc(88dvh-3.25rem)] overflow-y-auto overscroll-contain px-5 pb-[max(1rem,env(safe-area-inset-bottom))]"
            ref={(element) => {
              contentRef(element)
              scrollContainerRef.current = element
            }}
          >
            <div className="sticky top-0 z-20 -mx-1 mb-3 bg-popover/95 px-1 pb-1 backdrop-blur">
              {view === "overview" ? (
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium tabular-nums text-muted-foreground">
                    {currentPosition} of {total}
                  </span>

                  <div className="flex items-center gap-1">
                    <Button
                      aria-label="Previous transaction"
                      data-vaul-no-drag=""
                      disabled={!canGoPrevious}
                      onClick={() => onNavigate(-1)}
                      size="icon-lg"
                      type="button"
                      variant="ghost"
                    >
                      <ArrowUp />
                    </Button>
                    <Button
                      aria-label="Next transaction"
                      data-vaul-no-drag=""
                      disabled={!canGoNext}
                      onClick={() => onNavigate(1)}
                      size="icon-lg"
                      type="button"
                      variant="ghost"
                    >
                      <ArrowDown />
                    </Button>
                    <Button
                      aria-label="Close transaction details"
                      data-vaul-no-drag=""
                      onClick={() => onOpenChange(false)}
                      size="icon-lg"
                      type="button"
                      variant="ghost"
                    >
                      <X />
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Button
                    aria-label="Back to transaction overview"
                    data-vaul-no-drag=""
                    onClick={goBack}
                    size="icon-lg"
                    type="button"
                    variant="ghost"
                  >
                    <ArrowLeft />
                  </Button>
                  <h3 className="min-w-0 flex-1 truncate text-lg font-semibold tracking-tight">
                    {mobileViewTitle(view)}
                  </h3>
                  <Button
                    aria-label="Close transaction details"
                    data-vaul-no-drag=""
                    onClick={() => onOpenChange(false)}
                    size="icon-lg"
                    type="button"
                    variant="ghost"
                  >
                    <X />
                  </Button>
                </div>
              )}
            </div>

            <AnimatePresence custom={direction} initial={false} mode="popLayout">
              <motion.div
                animate={{ opacity: 1, transform: "translateX(0px)" }}
                custom={direction}
                exit={{
                  opacity: 0,
                  transform:
                    reduceMotion === true ? "translateX(0px)" : `translateX(${-8 * direction}px)`,
                }}
                initial={{
                  opacity: 0,
                  transform:
                    reduceMotion === true ? "translateX(0px)" : `translateX(${8 * direction}px)`,
                }}
                key={view}
                transition={{
                  duration: reduceMotion === true ? 0.12 : opacityDuration,
                  ease: [0.26, 0.08, 0.25, 1],
                }}
              >
                <MobileInspectorContent
                  onOpenView={openView}
                  transaction={transaction}
                  view={view}
                />
              </motion.div>
            </AnimatePresence>
          </div>
        </motion.div>
      </BottomSheetContent>
    </BottomSheet>
  )
}

function mobileViewTitle(view: Exclude<MobileInspectorView, "overview">) {
  switch (view) {
    case "tax":
      return "Tax calculation"
    case "source":
      return "Source evidence"
    case "classification":
      return "Classification trail"
  }
}

function MobileInspectorContent({
  onOpenView,
  transaction,
  view,
}: {
  onOpenView: (view: Exclude<MobileInspectorView, "overview">) => void
  transaction: Transaction | undefined
  view: MobileInspectorView
}) {
  if (transaction === undefined) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">No transaction selected.</p>
    )
  }

  switch (view) {
    case "tax":
      return <MobileTaxView transaction={transaction} />
    case "source":
      return <MobileSourceView transaction={transaction} />
    case "classification":
      return <MobileClassificationView transaction={transaction} />
    default:
      return <MobileOverview onOpenView={onOpenView} transaction={transaction} />
  }
}

function MobileOverview({
  onOpenView,
  transaction,
}: {
  onOpenView: (view: Exclude<MobileInspectorView, "overview">) => void
  transaction: Transaction
}) {
  const fees = transaction.movements.filter((movement) => movement.role === "fee")
  const primaryMovements = transaction.movements.filter((movement) => movement.role !== "fee")

  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Badge variant="outline">{typeLabel(transaction.type)}</Badge>
          <h3 className="mt-3 text-xl font-semibold tracking-tight">{transaction.title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatDate(transaction.occurredAt)} at {formatTime(transaction.occurredAt)}
          </p>
        </div>
        {transaction.needsReview === true ? (
          <Badge className="gap-1" variant="secondary">
            <CircleAlert /> Review
          </Badge>
        ) : null}
      </div>

      <div className="mt-5 space-y-2">
        {primaryMovements.map((movement) => (
          <MovementCard key={movement.id} movement={movement} />
        ))}
        {fees.map((fee) => (
          <div
            className="rounded-lg border border-dashed border-amber-500/30 bg-amber-500/5 p-3"
            key={fee.id}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-xs font-medium text-amber-700 dark:text-amber-300">
                  Linked fee
                </div>
                <div className="mt-1 font-semibold tabular-nums">
                  −{fee.amount} {fee.asset}
                </div>
              </div>
              <div className="text-right text-xs tabular-nums text-muted-foreground">
                {formatCurrency(fee.eurValue)}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-5 space-y-2 border-t pt-4">
        <MobileDetailLink
          icon={Calculator}
          label="Tax calculation"
          onClick={() => onOpenView("tax")}
          value={
            transaction.gainLoss === undefined
              ? transaction.treatment
              : `${formatGainLoss(transaction.gainLoss)} realized`
          }
        />
        <MobileDetailLink
          icon={FileSearch}
          label="Source evidence"
          onClick={() => onOpenView("source")}
          value={`${transaction.source} · ${transaction.sourceReference}`}
        />
        <MobileDetailLink
          icon={History}
          label="Classification trail"
          onClick={() => onOpenView("classification")}
          value={`${transaction.classificationTrail.length} ${transaction.classificationTrail.length === 1 ? "event" : "events"} · Current ${typeLabel(transaction.type)}`}
        />
      </div>
    </div>
  )
}

function MobileDetailLink({
  icon: Icon,
  label,
  onClick,
  value,
}: {
  icon: typeof History
  label: string
  onClick: () => void
  value: string
}) {
  return (
    <button
      className="flex min-h-16 w-full items-center gap-3 rounded-xl border bg-background px-3 py-2.5 text-left transition-colors [@media(hover:hover)_and_(pointer:fine)]:hover:bg-muted/50"
      data-vaul-no-drag=""
      onClick={onClick}
      type="button"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">{label}</span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">{value}</span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </button>
  )
}

function MobileTaxView({ transaction }: { transaction: Transaction }) {
  const feeValue = transaction.movements
    .filter((movement) => movement.role === "fee")
    .reduce((total, movement) => total + movement.eurValue, 0)

  return (
    <div className="px-3">
      <dl className="divide-y text-sm [&>div]:py-3">
        <Detail label="Transaction value">{formatCurrency(transaction.fiatValue)}</Detail>
        <Detail label="Proceeds">
          {transaction.proceeds === undefined
            ? "Not applicable"
            : formatCurrency(transaction.proceeds)}
        </Detail>
        <Detail label="Cost basis">
          {transaction.costBasis === undefined
            ? "Not applicable"
            : formatCurrency(transaction.costBasis)}
        </Detail>
        <Detail label="Fees">{feeValue === 0 ? "None" : formatCurrency(feeValue)}</Detail>
        <Detail label="Realized profit / loss">
          {transaction.gainLoss === undefined
            ? "Not applicable"
            : formatGainLoss(transaction.gainLoss)}
        </Detail>
        <Detail label="Tax treatment">{transaction.treatment}</Detail>
      </dl>
    </div>
  )
}

function MobileSourceView({ transaction }: { transaction: Transaction }) {
  return (
    <div className="px-3">
      <dl className="divide-y text-sm [&>div]:py-3">
        <Detail label="Source">
          <span className="flex items-center justify-end gap-1.5">
            <SourceIcon kind={transaction.sourceKind} /> {transaction.source}
          </span>
        </Detail>
        <Detail label="Account">{transaction.sourceReference}</Detail>
        <Detail label="Network">{transaction.network ?? "Exchange"}</Detail>
        <Detail label="Counterparty">{transaction.counterparty ?? "—"}</Detail>
        <Detail label="Reference">
          <span className="break-all font-mono text-xs">{transaction.externalReference}</span>
        </Detail>
        <Detail label="Price source">{transaction.priceSource}</Detail>
      </dl>
    </div>
  )
}

function MobileClassificationView({ transaction }: { transaction: Transaction }) {
  return (
    <div className="px-3">
      <ClassificationTrail
        className="mt-0 border-t-0 pt-0"
        currentType={transaction.type}
        events={transaction.classificationTrail}
        headingId="mobile-classification-trail-heading"
        hideHeading
      />
    </div>
  )
}

function TransactionInspector({ transaction }: { transaction: Transaction | undefined }) {
  if (transaction === undefined) {
    return (
      <div className="flex items-center justify-center p-8 text-sm text-muted-foreground">
        Select a transaction to inspect it.
      </div>
    )
  }

  const fees = transaction.movements.filter((movement) => movement.role === "fee")
  const primaryMovements = transaction.movements.filter((movement) => movement.role !== "fee")
  const feeValue = fees.reduce((total, movement) => total + movement.eurValue, 0)

  return (
    <aside className="min-w-0 bg-muted/20 p-5 sm:p-6 lg:max-h-[56rem] lg:overflow-y-auto">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Badge variant="outline">{typeLabel(transaction.type)}</Badge>
          <h3 className="mt-3 text-xl font-semibold tracking-tight">{transaction.title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatDate(transaction.occurredAt)} at {formatTime(transaction.occurredAt)}
          </p>
        </div>
        {transaction.needsReview === true ? (
          <Badge className="gap-1" variant="secondary">
            <CircleAlert /> Review
          </Badge>
        ) : (
          <Badge className="gap-1" variant="outline">
            <CheckCircle2 /> Classified
          </Badge>
        )}
      </div>

      <section className="mt-6" aria-labelledby="asset-movements-heading">
        <SectionHeading id="asset-movements-heading">Asset movements</SectionHeading>
        <div className="mt-3 space-y-2">
          {primaryMovements.map((movement) => (
            <MovementCard key={movement.id} movement={movement} />
          ))}
        </div>

        {fees.length === 0 ? null : (
          <div className="mt-3 rounded-lg border border-dashed border-amber-500/30 bg-amber-500/5 p-3">
            {fees.map((fee) => (
              <div className="flex items-start justify-between gap-4" key={fee.id}>
                <div>
                  <div className="text-xs font-medium text-amber-700 dark:text-amber-300">
                    Fee linked to this {transaction.type}
                  </div>
                  <div className="mt-1 font-semibold tabular-nums">
                    −{fee.amount} {fee.asset}
                  </div>
                </div>
                <div className="text-right text-xs tabular-nums text-muted-foreground">
                  {formatCurrency(fee.eurValue)}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mt-7 border-t pt-6" aria-labelledby="tax-calculation-heading">
        <SectionHeading id="tax-calculation-heading">Tax calculation</SectionHeading>
        <dl className="mt-3 space-y-3 text-sm">
          <Detail label="Transaction value">{formatCurrency(transaction.fiatValue)}</Detail>
          <Detail label="Proceeds">
            {transaction.proceeds === undefined
              ? "Not applicable"
              : formatCurrency(transaction.proceeds)}
          </Detail>
          <Detail label="Cost basis">
            {transaction.costBasis === undefined
              ? "Not applicable"
              : formatCurrency(transaction.costBasis)}
          </Detail>
          <Detail label="Fees">{feeValue === 0 ? "None" : formatCurrency(feeValue)}</Detail>
          <Detail label="Realized profit / loss">
            {transaction.gainLoss === undefined
              ? "Not applicable"
              : formatGainLoss(transaction.gainLoss)}
          </Detail>
          <Detail label="Tax treatment">{transaction.treatment}</Detail>
        </dl>
      </section>

      <section className="mt-7 border-t pt-6" aria-labelledby="source-evidence-heading">
        <SectionHeading id="source-evidence-heading">Source evidence</SectionHeading>
        <dl className="mt-3 space-y-3 text-sm">
          <Detail label="Source">
            <span className="flex items-center justify-end gap-1.5">
              <SourceIcon kind={transaction.sourceKind} /> {transaction.source}
            </span>
          </Detail>
          <Detail label="Account">{transaction.sourceReference}</Detail>
          <Detail label="Network">{transaction.network ?? "Exchange"}</Detail>
          <Detail label="Counterparty">{transaction.counterparty ?? "—"}</Detail>
          <Detail label="Reference">
            <span className="font-mono text-xs">{transaction.externalReference}</span>
          </Detail>
          <Detail label="Price source">{transaction.priceSource}</Detail>
        </dl>
      </section>

      <ClassificationTrail
        currentType={transaction.type}
        events={transaction.classificationTrail}
      />
    </aside>
  )
}

function MovementCard({ movement }: { movement: Movement }) {
  const isOutgoing = movement.role === "disposed" || movement.role === "fee"

  return (
    <div className="rounded-lg border bg-background p-3">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <RoleIcon role={movement.role} /> {roleLabel(movement.role)}
        </span>
        <span className="tabular-nums">{formatCurrency(movement.eurValue)}</span>
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums">
        {isOutgoing ? "−" : "+"}
        {movement.amount} {movement.asset}
      </div>
    </div>
  )
}

function ClassificationTrail({
  className,
  currentType,
  events,
  headingId = "classification-trail-heading",
  hideHeading = false,
}: {
  className?: string
  currentType: TransactionType
  events: ReadonlyArray<ClassificationEvent>
  headingId?: string
  hideHeading?: boolean
}) {
  return (
    <section className={cn("mt-7 border-t pt-6", className)} aria-labelledby={headingId}>
      <div className="flex items-center justify-between gap-3">
        {hideHeading ? (
          <h4 className="sr-only" id={headingId}>
            Classification trail
          </h4>
        ) : (
          <SectionHeading id={headingId}>
            <History className="size-4" /> Classification trail
          </SectionHeading>
        )}
        <Badge variant="secondary">Current: {typeLabel(currentType)}</Badge>
      </div>

      <ol className="relative mt-4 space-y-4 before:absolute before:top-3 before:bottom-3 before:left-[0.6875rem] before:w-px before:bg-border">
        {events.map((event) => (
          <ClassificationEventItem event={event} key={event.id} />
        ))}
      </ol>
    </section>
  )
}

function ClassificationEventItem({ event }: { event: ClassificationEvent }) {
  const actor = classificationActor(event.actor)
  const ActorIcon = actor.icon

  return (
    <li className="relative pl-9">
      <span
        className={cn(
          "absolute top-1 left-0 z-10 flex size-[1.375rem] items-center justify-center rounded-full border bg-background",
          actor.iconClassName
        )}
      >
        <ActorIcon className="size-3" />
      </span>

      <div className="rounded-lg border bg-background/70 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-semibold">{actor.label}</span>
          <time className="text-xs tabular-nums text-muted-foreground">
            {formatDateTime(event.occurredAt)}
          </time>
        </div>

        <p className="mt-2 text-sm font-medium">{classificationEventDescription(event)}</p>

        {event.reason === undefined ? null : (
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{event.reason}</p>
        )}
        {event.note === undefined ? null : (
          <blockquote className="mt-2 border-l-2 pl-3 text-xs leading-relaxed text-muted-foreground">
            “{event.note}”
          </blockquote>
        )}

        {event.confidence === undefined &&
        event.matchedLayer === undefined &&
        event.legalRuleSetVersion === undefined ? null : (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {event.confidence === undefined ? null : (
              <Badge variant="outline">{Math.round(event.confidence * 100)}% confidence</Badge>
            )}
            {event.matchedLayer === undefined ? null : (
              <Badge variant="outline">{typeLabel(event.matchedLayer)}</Badge>
            )}
            {event.legalRuleSetVersion === undefined ? null : (
              <Badge variant="outline">Ruleset {event.legalRuleSetVersion}</Badge>
            )}
          </div>
        )}
      </div>
    </li>
  )
}

function classificationActor(actor: ClassificationActor): {
  label: string
  icon: typeof Bot
  iconClassName: string
} {
  switch (actor) {
    case "system":
      return { label: "TaxMaxi system", icon: Bot, iconClassName: "text-sky-600 dark:text-sky-300" }
    case "user":
      return {
        label: "You",
        icon: UserRound,
        iconClassName: "text-emerald-700 dark:text-emerald-300",
      }
    case "admin":
      return {
        label: "TaxMaxi admin",
        icon: ShieldCheck,
        iconClassName: "text-violet-700 dark:text-violet-300",
      }
  }
}

function classificationEventDescription(event: ClassificationEvent) {
  switch (event.action) {
    case "assigned":
      return `Assigned ${typeLabel(event.toType)}`
    case "confirmed":
      return `Confirmed ${typeLabel(event.toType)}`
    case "changed":
      return `Changed ${typeLabel(event.fromType ?? "unclassified")} to ${typeLabel(event.toType)}`
  }
}

function SectionHeading({ children, id }: { children: ReactNode; id: string }) {
  return (
    <h4 className="flex items-center gap-2 text-sm font-semibold" id={id}>
      {children}
    </h4>
  )
}

function Detail({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="max-w-[65%] text-right font-medium">{children}</dd>
    </div>
  )
}
