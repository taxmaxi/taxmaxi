/**
 * SolanaReferenceData - seed data for the Solana-focused hackathon database.
 *
 * The transaction taxonomy and CEX/bootstrap rows are carried over from the
 * original TaxMaxi seed migrations, but kept as db-push companion data instead
 * of a migration chain.
 *
 * @module seed/SolanaReferenceData
 */

import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import { drizzle } from "../layers/PgClientLive.ts"
import { schema } from "../schema/index.ts"

const seedTimestamp = new Date("2026-01-01T00:00:00.000Z")

const blockchains = [
  {
    name: "bitcoin",
    chainType: "bitcoin",
    chainId: null,
    nativeAssetSymbol: "BTC",
    explorerUrl: "https://mempool.space",
    logoUrl: null,
    coingeckoPlatformId: "bitcoin",
  },
  {
    name: "ethereum",
    chainType: "evm",
    chainId: 1,
    nativeAssetSymbol: "ETH",
    explorerUrl: "https://etherscan.io",
    logoUrl: null,
    coingeckoPlatformId: "ethereum",
  },
  {
    name: "base",
    chainType: "evm",
    chainId: 8453,
    nativeAssetSymbol: "ETH",
    explorerUrl: "https://basescan.org",
    logoUrl: null,
    coingeckoPlatformId: "base",
  },
  {
    name: "solana",
    chainType: "solana",
    chainId: null,
    nativeAssetSymbol: "SOL",
    explorerUrl: "https://explorer.solana.com",
    logoUrl: null,
    coingeckoPlatformId: "solana",
  },
] as const

const solanaNativeAsset = {
  contractAddress: null,
  name: "Solana",
  symbol: "SOL",
  decimals: 9,
  type: "native",
  logoUrl: null,
  isSpam: false,
} as const

const solanaTokenAssets = [
  {
    contractAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    name: "USD Coin",
    symbol: "USDC",
    decimals: 6,
    type: "token",
    logoUrl: null,
    isSpam: false,
  },
  {
    contractAddress: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    name: "Tether USD",
    symbol: "USDT",
    decimals: 6,
    type: "token",
    logoUrl: null,
    isSpam: false,
  },
] as const

const cexRows = [
  { name: "coinbase", website: "https://www.coinbase.com" },
  { name: "kraken", website: "https://www.kraken.com" },
  { name: "binance", website: "https://www.binance.com" },
  { name: "bitstamp", website: "https://www.bitstamp.net" },
] as const

const transactionCategories = [
  ["income", "Income", "Einkommen"],
  ["expense", "Expense", "Ausgabe"],
  ["transfer", "Transfer", "Transfer"],
  ["trade", "Trade", "Handel"],
  ["derivatives", "Derivatives", "Derivate"],
  ["staking", "Staking", "Staking"],
  ["lending", "Lending", "Verleihen"],
  ["liquidity", "Liquidity", "Liquiditaet"],
  ["nft", "NFT", "NFT"],
  ["other", "Other", "Sonstiges"],
] as const

const transactionSubcategories = [
  ["reward_earned", "Reward/Earned", "Belohnung/Verdient"],
  ["gift_other", "Gift/Other", "Geschenk/Sonstiges"],
  ["service_goods_payment", "Service/Goods Payment", "Dienstleistung/Warenzahlung"],
  ["derivative_outcome", "Derivative Outcome", "Derivate-Ergebnis"],
  ["fee_type", "Fee Type", "Gebuehrenart"],
  ["gift_donation", "Gift/Donation", "Geschenk/Spende"],
  ["loss_type", "Loss Type", "Verlustart"],
  ["tax_related", "Tax Related", "Steuerbezogen"],
  ["wallet_account_movement", "Wallet/Account Movement", "Wallet/Kontobewegung"],
  ["cross_chain_movement", "Cross-Chain Movement", "Cross-Chain-Bewegung"],
  ["protocol_event", "Protocol Event", "Protokollereignis"],
  ["spot_basic_trade", "Spot/Basic Trade", "Spot/Grundhandel"],
  ["other", "Other", "Sonstiges"],
  ["position_management", "Position Management", "Positionsverwaltung"],
  ["funding", "Funding", "Finanzierung"],
  ["cost", "Cost", "Kosten"],
  ["collateral_management", "Collateral Management", "Sicherheitenverwaltung"],
  ["creation", "Creation", "Erstellung"],
  ["marketplace", "Marketplace", "Marktplatz"],
  ["royalty", "Royalty", "Lizenzgebuehr"],
  ["exclusion", "Exclusion", "Ausschluss"],
  ["adjustment", "Adjustment", "Anpassung"],
  ["needs_review", "Needs Review", "Benoetigt Ueberpruefung"],
] as const

const transactionTypes = [
  ["airdrop", "income", "reward_earned", "Airdrop", "Airdrop"],
  ["bounty", "income", "reward_earned", "Bounty", "Bounty"],
  ["cashback", "income", "reward_earned", "Cashback", "Cashback"],
  ["fork_income", "income", "reward_earned", "Fork Income", "Fork-Einkommen"],
  ["gift_received", "income", "gift_other", "Gift (Received)", "Geschenk (Eingang)"],
  ["governance_reward", "income", "reward_earned", "Governance Reward", "Governance Belohnung"],
  ["interest_received", "income", "reward_earned", "Interest (Received)", "Zinsen (Eingang)"],
  ["mining_reward", "income", "reward_earned", "Mining Reward", "Mining Belohnung"],
  ["masternode_reward", "income", "reward_earned", "Masternode Reward", "Masternode Belohnung"],
  ["other_income", "income", "other", "Other Income", "Sonstiges Einkommen"],
  [
    "security_token_income",
    "income",
    "reward_earned",
    "Security Token Income",
    "Security Token Einkommen",
  ],
  ["staking_reward", "income", "reward_earned", "Staking Reward", "Staking Belohnung"],
  [
    "yield_farming_reward",
    "income",
    "reward_earned",
    "Yield Farming Reward",
    "Yield Farming Belohnung",
  ],
  [
    "payment_received",
    "income",
    "service_goods_payment",
    "Payment (Received)",
    "Zahlung (Eingang)",
  ],
  [
    "derivative_profit_received",
    "income",
    "derivative_outcome",
    "Derivative Profit Received",
    "Derivate-Gewinn erhalten",
  ],
  ["fee", "expense", "fee_type", "Fee (General)", "Gebuehr (Allgemein)"],
  ["platform_fee", "expense", "fee_type", "Platform Fee", "Plattformgebuehr"],
  ["gas_fee", "expense", "fee_type", "Gas Fee", "Gas-Gebuehr"],
  ["gift_sent", "expense", "gift_donation", "Gift (Sent)", "Geschenk (Ausgang)"],
  ["donation_sent", "expense", "gift_donation", "Donation (Sent)", "Spende (Ausgang)"],
  ["lost", "expense", "loss_type", "Lost", "Verloren"],
  ["theft", "expense", "loss_type", "Theft", "Diebstahl"],
  ["burn", "expense", "loss_type", "Burn", "Verbrennen"],
  ["payment_sent", "expense", "service_goods_payment", "Payment (Sent)", "Zahlung (Ausgang)"],
  [
    "withholding_tax_paid",
    "expense",
    "tax_related",
    "Withholding Tax (Paid)",
    "Quellensteuer (Gezahlt)",
  ],
  [
    "derivative_fee_paid",
    "expense",
    "fee_type",
    "Derivative Fee (Paid)",
    "Derivate-Gebuehr (Gezahlt)",
  ],
  ["transaction_cost", "expense", "fee_type", "Transaction Cost", "Transaktionskosten"],
  [
    "internal_transfer",
    "transfer",
    "wallet_account_movement",
    "Internal Transfer (between own wallets/accounts)",
    "Interner Transfer (zwischen eigenen Wallets/Konten)",
  ],
  [
    "bridging_transfer",
    "transfer",
    "cross_chain_movement",
    "Bridging Transfer",
    "Bridging Transfer",
  ],
  [
    "token_migration_transfer",
    "transfer",
    "protocol_event",
    "Token Migration Transfer",
    "Token-Migration Transfer",
  ],
  ["buy_fiat", "trade", "spot_basic_trade", "Buy (with Fiat)", "Kauf (mit Fiat)"],
  ["sell_fiat", "trade", "spot_basic_trade", "Sell (to Fiat)", "Verkauf (zu Fiat)"],
  [
    "swap_crypto_to_crypto",
    "trade",
    "spot_basic_trade",
    "Swap (Crypto to Crypto)",
    "Tausch (Krypto zu Krypto)",
  ],
  ["trade_other", "trade", "other", "Trade (Other)", "Handel (Sonstige)"],
  [
    "open_derivative_position",
    "derivatives",
    "position_management",
    "Open Position",
    "Position eroeffnen",
  ],
  [
    "close_derivative_position",
    "derivatives",
    "position_management",
    "Close Position",
    "Position schliessen",
  ],
  [
    "funding_payment_paid",
    "derivatives",
    "funding",
    "Funding Payment (Paid)",
    "Finanzierungszahlung (Gezahlt)",
  ],
  [
    "funding_payment_received",
    "derivatives",
    "funding",
    "Funding Payment (Received)",
    "Finanzierungszahlung (Erhalten)",
  ],
  [
    "margin_interest_paid",
    "derivatives",
    "cost",
    "Margin Interest (Paid)",
    "Margin Zinsen (Gezahlt)",
  ],
  ["liquidation", "derivatives", "position_management", "Liquidation", "Liquidation"],
  ["staking_deposit", "staking", "position_management", "Staking Deposit", "Staking Einzahlung"],
  [
    "staking_withdrawal",
    "staking",
    "position_management",
    "Staking Withdrawal",
    "Staking Auszahlung",
  ],
  ["lend_deposit", "lending", "position_management", "Lend Deposit", "Verleihen Einzahlung"],
  ["lend_withdrawal", "lending", "position_management", "Lend Withdrawal", "Verleihen Auszahlung"],
  ["borrow", "lending", "position_management", "Borrow", "Leihen"],
  ["repay_loan", "lending", "position_management", "Repay Loan", "Kredit zurueckzahlen"],
  [
    "collateral_deposit",
    "lending",
    "collateral_management",
    "Collateral Deposit",
    "Sicherheit Einzahlung",
  ],
  [
    "collateral_withdrawal",
    "lending",
    "collateral_management",
    "Collateral Withdrawal",
    "Sicherheit Auszahlung",
  ],
  ["add_liquidity", "liquidity", "position_management", "Add Liquidity", "Liquiditaet hinzufuegen"],
  [
    "remove_liquidity",
    "liquidity",
    "position_management",
    "Remove Liquidity",
    "Liquiditaet entfernen",
  ],
  ["nft_mint", "nft", "creation", "NFT Mint", "NFT Praegung"],
  ["nft_buy", "nft", "marketplace", "NFT Buy", "NFT Kauf"],
  ["nft_sell", "nft", "marketplace", "NFT Sell", "NFT Verkauf"],
  ["nft_transfer", "nft", "wallet_account_movement", "NFT Transfer", "NFT Transfer"],
  ["nft_royalty_income", "nft", "royalty", "NFT Royalty (Received)", "NFT-Lizenzgebuehr (Eingang)"],
  ["nft_royalty_expense", "nft", "royalty", "NFT Royalty (Paid)", "NFT-Lizenzgebuehr (Gezahlt)"],
  ["spam", "other", "exclusion", "Spam", "Spam"],
  ["refund", "other", "adjustment", "Refund", "Rueckerstattung"],
  ["chargeback", "other", "adjustment", "Chargeback/Reversal", "Rueckbuchung/Stornierung"],
  ["uncategorized", "other", "needs_review", "Uncategorized", "Unkategorisiert"],
] as const

interface LegalRuleSeed {
  readonly ruleKey: string
  readonly title: string
  readonly description: string
  readonly scope: string
  readonly outcomeCategory: string
  readonly machineReadable: Record<string, unknown>
}

const legalSource = {
  sourceKey: "de-bmf-krypto-2025-03-06",
  jurisdictionCode: "DE",
  sourceType: "administrative_guidance",
  authority: "Bundesministerium der Finanzen",
  title: "Einzelfragen zur ertragsteuerrechtlichen Behandlung von Kryptowerten",
  shortTitle: "BMF 2025-03-06",
  language: "de",
  sourceUrl:
    "https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Einkommensteuer/2025-03-06-einzelfragen-kryptowerte-bmf-schreiben.pdf",
  publishedAt: new Date("2025-03-06T00:00:00.000Z"),
  effectiveFrom: new Date("2025-03-06T00:00:00.000Z"),
  effectiveTo: null,
  checksumSha256: null,
} as const

const legalClauses = [
  {
    clauseKey: "DE.BMF.2025-03-06.RN31",
    sectionCode: "II.1",
    heading: "Wirtschaftsgutqualitaet von Kryptowerten",
    randnummer: "31",
    clauseText: "Die einzelnen Kryptowerte sind Wirtschaftsgueter und selbstaendig bewertbar.",
    summary: "Kryptowerte gelten steuerlich als Wirtschaftsgueter.",
  },
  {
    clauseKey: "DE.BMF.2025-03-06.RN32",
    sectionCode: "II.1",
    heading: "Wirtschaftsgutqualitaet von Kryptowerten",
    randnummer: "32",
    clauseText:
      "Wirtschaftlicher Eigentuemer ist regelmaessig, wer mit dem privaten Schluessel verfuegen kann.",
    summary: "Zurechnung erfolgt typischerweise an den Inhaber des privaten Schluessels.",
  },
  {
    clauseKey: "DE.BMF.2025-03-06.RN43",
    sectionCode: "II.2.a",
    heading: "Zugangsbewertung",
    randnummer: "43",
    clauseText:
      "Anschaffungskosten entsprechen dem Marktkurs im Anschaffungszeitpunkt; Tageskurse siehe RN91.",
    summary:
      "Bewertung erfolgt primaer zeitpunktgenau, Tageskurse sind als Vereinfachung geregelt.",
  },
  {
    clauseKey: "DE.BMF.2025-03-06.RN48",
    sectionCode: "II.3",
    heading: "Einkuenfte aus passivem Staking",
    randnummer: "48",
    clauseText:
      "Passives Staking unterliegt in der Regel der Besteuerung nach section 22 number 3 EStG.",
    summary: "Staking-Ertraege sind regelmaessig sonstige Einkuenfte.",
  },
  {
    clauseKey: "DE.BMF.2025-03-06.RN48A",
    sectionCode: "II.3",
    heading: "Einkuenfte aus passivem Staking",
    randnummer: "48a",
    clauseText:
      "Unterjaehrig kann vereinfachend die Wallet-Einbuchung (Claiming) als Zugangszeitpunkt dienen.",
    summary: "Claiming-Zeitpunkt ist als Vereinfachung akzeptiert.",
  },
  {
    clauseKey: "DE.BMF.2025-03-06.RN53",
    sectionCode: "II.5.b",
    heading: "Private Veraeusserungsgeschaefte",
    randnummer: "53",
    clauseText:
      "Private Gewinne sind steuerbar, wenn zwischen Anschaffung und Veraeusserung nicht mehr als ein Jahr liegt.",
    summary: "Einjahresfrist fuer section 23 EStG ist zentral.",
  },
  {
    clauseKey: "DE.BMF.2025-03-06.RN54",
    sectionCode: "II.5.b",
    heading: "Anschaffung und Veraeusserung",
    randnummer: "54",
    clauseText:
      "Tausch gegen Fiat, Waren, Dienstleistungen oder andere Kryptowerte ist ein Veraeusserungsvorgang.",
    summary: "Krypto-zu-Krypto-Tausch ist steuerlich relevant.",
  },
  {
    clauseKey: "DE.BMF.2025-03-06.RN55",
    sectionCode: "II.5.b",
    heading: "Fristbeginn",
    randnummer: "55",
    clauseText:
      "Die Veraeusserungsfrist beginnt nach jedem Tausch neu; bei CEX gelten Plattformzeitpunkte.",
    summary: "Jeder Tausch setzt die Frist neu.",
  },
  {
    clauseKey: "DE.BMF.2025-03-06.RN57",
    sectionCode: "II.5.b",
    heading: "Gewinnermittlung",
    randnummer: "57",
    clauseText:
      "Gewinn oder Verlust ergibt sich aus Veraeusserungserloes abzueglich Anschaffungs- und Werbungskosten.",
    summary: "Standardformel fuer private Veraeusserung.",
  },
  {
    clauseKey: "DE.BMF.2025-03-06.RN58",
    sectionCode: "II.5.b",
    heading: "Veraeusserungserloes beim Tausch",
    randnummer: "58",
    clauseText:
      "Beim Tausch ist der Marktkurs der erhaltenen Kryptowerte im Tauschzeitpunkt anzusetzen.",
    summary: "Marktwertansatz bei Krypto-zu-Krypto.",
  },
  {
    clauseKey: "DE.BMF.2025-03-06.RN59",
    sectionCode: "II.5.b",
    heading: "Anschaffungskosten und Gebuehren",
    randnummer: "59",
    clauseText: "Transaktionsgebuehren koennen als Werbungskosten beruecksichtigt werden.",
    summary: "Gebuehren sind bei der Gewinnermittlung relevant.",
  },
  {
    clauseKey: "DE.BMF.2025-03-06.RN61",
    sectionCode: "II.5.b",
    heading: "Verwendungsreihenfolge",
    randnummer: "61",
    clauseText:
      "Mangels Einzelzuordnung kann fuer Wertermittlung FiFo als Vereinfachung verwendet werden.",
    summary: "FiFo ist erlaubt, wenn Einzelzuordnung nicht moeglich ist.",
  },
  {
    clauseKey: "DE.BMF.2025-03-06.RN62",
    sectionCode: "II.5.b",
    heading: "Walletbezogene Betrachtung",
    randnummer: "62",
    clauseText: "Methodenwahl gilt walletbezogen und je Handelsbezeichnung bis zur Vollaufloesung.",
    summary: "Verbrauchsmethode muss pro Wallet konsistent bleiben.",
  },
  {
    clauseKey: "DE.BMF.2025-03-06.RN63",
    sectionCode: "II.5.b",
    heading: "Keine Verlaengerung auf zehn Jahre",
    randnummer: "63",
    clauseText: "Bei Currency/Payment Token findet die Zehnjahresfrist keine Anwendung.",
    summary: "Keine Fristverlaengerung fuer Payment Token.",
  },
  {
    clauseKey: "DE.BMF.2025-03-06.RN65",
    sectionCode: "II.6.b",
    heading: "Lending im Privatvermoegen",
    randnummer: "65",
    clauseText: "Lending-Ertraege sind nach section 22 number 3 EStG steuerbar.",
    summary: "Lending-Einkuenfte sind sonstige Einkuenfte.",
  },
  {
    clauseKey: "DE.BMF.2025-03-06.RN68",
    sectionCode: "II.7.b",
    heading: "Hard Fork im Privatvermoegen",
    randnummer: "68",
    clauseText:
      "Hard Fork selbst fuehrt nicht zu section 22 number 3 EStG; spaetere Veraeusserung kann section 23 EStG unterliegen.",
    summary: "Hard Fork selbst ist nicht sofort als sonstige Einkunft zu erfassen.",
  },
  {
    clauseKey: "DE.BMF.2025-03-06.RN70",
    sectionCode: "II.8.b",
    heading: "Airdrop mit Leistung",
    randnummer: "70",
    clauseText:
      "Bei Airdrops mit aktivem Tun kann eine Leistung nach section 22 number 3 EStG vorliegen.",
    summary: "Leistungsgebundene Airdrops sind typischerweise steuerbar.",
  },
  {
    clauseKey: "DE.BMF.2025-03-06.RN71",
    sectionCode: "II.8.b",
    heading: "Datenueberlassung als Leistung",
    randnummer: "71",
    clauseText:
      "Die Ueberlassung personenbezogener Daten ueber technische Mindestanforderungen hinaus kann eine Leistung nach section 22 number 3 EStG sein.",
    summary: "Datenbereitstellung kann als Gegenleistung fuer Airdrops gelten.",
  },
  {
    clauseKey: "DE.BMF.2025-03-06.RN72",
    sectionCode: "II.8.b",
    heading: "Zufallselement bei Airdrops",
    randnummer: "72",
    clauseText:
      "Wenn neben einer Leistung auch der Zufall ueber den Erhalt entscheidet, kann der Zurechnungszusammenhang zwischen Leistung und Gegenleistung unterbrochen sein.",
    summary: "Zufall kann den Leistungsbezug fuer Airdrops relativieren.",
  },
  {
    clauseKey: "DE.BMF.2025-03-06.RN73",
    sectionCode: "II.8.b",
    heading: "Bewertung von Airdrops",
    randnummer: "73",
    clauseText:
      "Airdrops werden mit Marktkurs im Erwerbszeitpunkt angesetzt; bei fehlendem Kurs ist 0 Euro nicht beanstandet.",
    summary: "Bewertungsvorgabe fuer Airdrops inklusive 0-Euro-Fallback.",
  },
  {
    clauseKey: "DE.BMF.2025-03-06.RN74",
    sectionCode: "II.8.b",
    heading: "Airdrop ohne Leistung",
    randnummer: "74",
    clauseText:
      "Erfolgt die Zuteilung nicht im wirtschaftlichen Zusammenhang mit einer Leistung, kommt eine Schenkung in Betracht.",
    summary: "Airdrops ohne Gegenleistung koennen als Schenkung einzuordnen sein.",
  },
  {
    clauseKey: "DE.BMF.2025-03-06.RN75",
    sectionCode: "II.8.b",
    heading: "Anschaffung bei Leistungsaustausch",
    randnummer: "75",
    clauseText:
      "Leistungsgebundene Airdrops begruenden Anschaffung; spaetere Veraeusserung kann section 23 EStG ausloesen.",
    summary: "Airdrops koennen zusaetzlich private Veraeusserungsgeschaefte vorbereiten.",
  },
  {
    clauseKey: "DE.BMF.2025-03-06.RN87",
    sectionCode: "III.1",
    heading: "Allgemeine Mitwirkung",
    randnummer: "87",
    clauseText:
      "Die alleinige Ueberlassung eines oeffentlichen Schluessels reicht fuer steuerliche Nachweise nicht aus.",
    summary: "Zusatzunterlagen sind fuer Nachvollziehbarkeit erforderlich.",
  },
  {
    clauseKey: "DE.BMF.2025-03-06.RN89",
    sectionCode: "III.1",
    heading: "Erweiterte Mitwirkungspflicht",
    randnummer: "89",
    clauseText:
      "Bei auslaendischen CEX und regelmaessig DEX gilt erweiterte Mitwirkungspflicht; Datenverluste gehen zulasten der Steuerpflichtigen.",
    summary: "Vollstaendige Datenbeschaffung ist Pflicht.",
  },
  {
    clauseKey: "DE.BMF.2025-03-06.RN90",
    sectionCode: "III.1",
    heading: "Steuerreports",
    randnummer: "90",
    clauseText:
      "Steuerreports sind bei Plausibilitaet und Nachvollziehbarkeit als Grundlage moeglich.",
    summary: "Reporte sind erlaubt, aber nur bei belastbarer Dokumentation.",
  },
  {
    clauseKey: "DE.BMF.2025-03-06.RN91",
    sectionCode: "III.1",
    heading: "Tageskurse",
    randnummer: "91",
    clauseText:
      "Tageskurse sind bei gleichmaessiger Wertermittlung mit konsistenter Quelle und Methodik beruecksichtigungsfaehig.",
    summary: "Konsistenz bei Kursquelle und Zeitlogik ist zwingend.",
  },
  {
    clauseKey: "DE.BMF.2025-03-06.RN92",
    sectionCode: "III.1",
    heading: "Schaetzung",
    randnummer: "92",
    clauseText: "Bei unzureichenden Angaben darf die Finanzbehoerde nach section 162 AO schaetzen.",
    summary: "Unvollstaendige Daten koennen zu Schaetzung fuehren.",
  },
  {
    clauseKey: "DE.BMF.2025-03-06.RN101",
    sectionCode: "III.3",
    heading: "Nachvollziehbarkeit im Privatvermoegen",
    randnummer: "101",
    clauseText:
      "Plausible Steuerreports dienen der Nachvollziehbarkeit; die zugrunde liegenden Dateien koennen angefordert werden.",
    summary: "Report-Inputs muessen pruefbar vorgehalten werden.",
  },
  {
    clauseKey: "DE.BMF.2025-03-06.RN102",
    sectionCode: "III.3",
    heading: "Strukturierte Uebersichten",
    randnummer: "102",
    clauseText:
      "Steuerpflichtige sollen strukturierte Uebersichten bereitstellen, damit private Veraeusserungsgeschaefte nachvollziehbar sind.",
    summary: "Veraeusserungsvorgaenge muessen einzeln nachvollziehbar dokumentiert sein.",
  },
  {
    clauseKey: "DE.BMF.2025-03-06.RN103",
    sectionCode: "III.3",
    heading: "Anforderbare Unterlagen",
    randnummer: "103",
    clauseText:
      "Je nach Komplexitaet koennen Angaben zu Anschaffung, Veraeusserung, Kursquellen, Methodenwahl und sonstigen Einkuenften verlangt werden.",
    summary: "Dokumentationsanforderungen umfassen auch Kursquelle und Methodenwahl.",
  },
  {
    clauseKey: "DE.BMF.2025-03-06.RN104",
    sectionCode: "III.3",
    heading: "Weitere Einzelfallinformationen",
    randnummer: "104",
    clauseText:
      "Angaben zu Mittelherkunft, Wallet-Bestaenden, Wallet-Adressen und Hash-Werten koennen fuer die Pruefung noetig sein.",
    summary: "Einzelfallpruefungen koennen erweiterte Wallet-Daten erfordern.",
  },
  {
    clauseKey: "DE.BMF.2025-03-06.RN105",
    sectionCode: "III.3",
    heading: "Aufbewahrungspflichten",
    randnummer: "105",
    clauseText:
      "Bei hohen Ueberschusseinkuenften gelten Aufbewahrungspflichten nach section 147a AO fuer sechs Jahre.",
    summary: "Aufbewahrungspflichten koennen bei hohen Einkuenften greifen.",
  },
  {
    clauseKey: "DE.BMF.2025-03-06.RN106",
    sectionCode: "IV",
    heading: "Anwendungsregel",
    randnummer: "106",
    clauseText:
      "Das Schreiben gilt fuer offene Faelle ab Veroeffentlichung; einzelne Nichtbeanstandungen gelten fuer Zeitraeume bis 2024.",
    summary: "Regelt zeitliche Anwendung und Uebergangslogik.",
  },
] as const

const legalRules: ReadonlyArray<LegalRuleSeed> = [
  {
    ruleKey: "de.foundation.crypto-is-economic-asset",
    title: "Kryptowerte als Wirtschaftsgueter",
    description:
      "Kryptowerte werden steuerlich als Wirtschaftsgueter behandelt und dem wirtschaftlichen Eigentuemer zugerechnet.",
    scope: "classification",
    outcomeCategory: "asset_characterization",
    machineReadable: { domain: "classification", jurisdiction: "DE" },
  },
  {
    ruleKey: "de.private.section23.disposal-within-one-year",
    title: "Private Veraeusserung innerhalb der Haltefrist",
    description:
      "Veraeusserungen innerhalb von einem Jahr unterliegen section 23 EStG; umfasst Fiat-Verkauf, Krypto-Tausch und Zahlungen.",
    scope: "private_disposal",
    outcomeCategory: "section23",
    machineReadable: { domain: "private_disposal", oneYearWindow: true },
  },
  {
    ruleKey: "de.private.section23.wallet-fifo-method",
    title: "Walletbezogene FiFo-/Methodenkonsistenz",
    description:
      "Bei fehlender Einzelzuordnung ist eine konsistente walletbezogene Methode zu verwenden.",
    scope: "lot_selection",
    outcomeCategory: "valuation_method",
    machineReadable: { domain: "lot_selection", walletScoped: true },
  },
  {
    ruleKey: "de.private.section23.no-ten-year-extension-currency-token",
    title: "Keine Zehnjahresfrist fuer Payment Token",
    description:
      "Fuer Currency/Payment Token gilt keine Verlaengerung der Haltefrist auf zehn Jahre.",
    scope: "holding_period",
    outcomeCategory: "section23",
    machineReadable: { domain: "holding_period", tenYearExtension: false },
  },
  {
    ruleKey: "de.private.section22.staking-income",
    title: "Staking als sonstige Einkuenfte",
    description:
      "Passives Staking ist grundsaetzlich sonstige Einkuenfte; Claiming-Zeitpunkt kann unterjaehrig vereinfachend genutzt werden.",
    scope: "income",
    outcomeCategory: "section22",
    machineReadable: { domain: "income", category: "staking" },
  },
  {
    ruleKey: "de.private.section22.lending-income",
    title: "Lending als sonstige Einkuenfte",
    description: "Lending-Ertraege sind als sonstige Einkuenfte zu behandeln.",
    scope: "income",
    outcomeCategory: "section22",
    machineReadable: { domain: "income", category: "lending" },
  },
  {
    ruleKey: "de.private.airdrop.section22-or-gift",
    title: "Airdrop: Leistung oder Schenkung",
    description:
      "Airdrops sind je nach Leistungsbezug als sonstige Einkuenfte oder als Schenkung einzuordnen.",
    scope: "income_classification",
    outcomeCategory: "section22_or_gift",
    machineReadable: { domain: "airdrop", requiresContext: true },
  },
  {
    ruleKey: "de.private.hard-fork.section23-follow-up-sale",
    title: "Hard Fork und Folgeveraeusserung",
    description:
      "Der Hard Fork selbst loest kein section 22 Ereignis aus; Folgeveraeusserungen sind nach section 23 zu pruefen.",
    scope: "fork",
    outcomeCategory: "section23_followup",
    machineReadable: { domain: "fork", immediateIncome: false },
  },
  {
    ruleKey: "de.valuation.market-price-and-daily-rate",
    title: "Bewertung mit Marktkursen/Tageskursen",
    description:
      "Bewertung erfolgt marktbasiert; Tageskurse sind nur bei konsistenter Methodik belastbar.",
    scope: "valuation",
    outcomeCategory: "pricing",
    machineReadable: { domain: "valuation", dailyRateConsistencyRequired: true },
  },
  {
    ruleKey: "de.compliance.recordkeeping-and-mitwirkung",
    title: "Mitwirkung, Nachweise und Schaetzungsrisiko",
    description:
      "Fehlende Nachweise oder inkonsistente Unterlagen erhoehen das Risiko einer schaetzungsbasierten Besteuerung.",
    scope: "compliance",
    outcomeCategory: "documentation",
    machineReadable: { domain: "compliance", estimationRisk: true },
  },
  {
    ruleKey: "de.transition.application-rule",
    title: "Anwendungs- und Uebergangsregel",
    description:
      "Das Schreiben gilt fuer offene Faelle ab Veroeffentlichung mit Nichtbeanstandungen fuer Zeitraeume bis 2024.",
    scope: "transition",
    outcomeCategory: "applicability",
    machineReadable: { domain: "transition", publicationDate: "2025-03-06" },
  },
] as const

const jurisdictionRuleSet = {
  jurisdictionCode: "DE",
  version: "de-crypto-income-tax-v2025-03-06",
  name: "DE Crypto Income Tax Ruleset (BMF 2025-03-06)",
  description:
    "Deterministic citation-backed DE crypto tax ruleset based on BMF letter 2025-03-06.",
  effectiveFrom: new Date("2025-03-06T00:00:00.000Z"),
  effectiveTo: null,
  isActive: true,
} as const

const jurisdictionRuleSetRules = [
  ["de.foundation.crypto-is-economic-asset", 10],
  ["de.private.section23.disposal-within-one-year", 20],
  ["de.private.section23.wallet-fifo-method", 30],
  ["de.private.section23.no-ten-year-extension-currency-token", 40],
  ["de.private.section22.staking-income", 50],
  ["de.private.section22.lending-income", 60],
  ["de.private.airdrop.section22-or-gift", 70],
  ["de.private.hard-fork.section23-follow-up-sale", 80],
  ["de.valuation.market-price-and-daily-rate", 90],
  ["de.compliance.recordkeeping-and-mitwirkung", 100],
  ["de.transition.application-rule", 110],
] as const

const legalRuleCitations = [
  [
    "de.foundation.crypto-is-economic-asset",
    "DE.BMF.2025-03-06.RN31",
    1,
    "Kryptowerte sind Wirtschaftsgueter.",
  ],
  [
    "de.foundation.crypto-is-economic-asset",
    "DE.BMF.2025-03-06.RN32",
    2,
    "Zurechnung an wirtschaftlichen Eigentuemer.",
  ],
  [
    "de.private.section23.disposal-within-one-year",
    "DE.BMF.2025-03-06.RN53",
    1,
    "Einjahresfrist fuer section 23.",
  ],
  [
    "de.private.section23.disposal-within-one-year",
    "DE.BMF.2025-03-06.RN54",
    2,
    "Tausch/Fiat/Payment als Veraeusserung.",
  ],
  [
    "de.private.section23.disposal-within-one-year",
    "DE.BMF.2025-03-06.RN55",
    3,
    "Fristbeginn nach jedem Tausch neu.",
  ],
  [
    "de.private.section23.disposal-within-one-year",
    "DE.BMF.2025-03-06.RN58",
    4,
    "Marktkursansatz beim Tausch.",
  ],
  [
    "de.private.section23.disposal-within-one-year",
    "DE.BMF.2025-03-06.RN59",
    5,
    "Gebuehren als Werbungskosten.",
  ],
  [
    "de.private.section23.wallet-fifo-method",
    "DE.BMF.2025-03-06.RN61",
    1,
    "FiFo/Methodenwahl bei fehlender Einzelzuordnung.",
  ],
  [
    "de.private.section23.wallet-fifo-method",
    "DE.BMF.2025-03-06.RN62",
    2,
    "Walletbezogene Methodenkonsistenz.",
  ],
  [
    "de.private.section23.no-ten-year-extension-currency-token",
    "DE.BMF.2025-03-06.RN63",
    1,
    "Keine Zehnjahresfrist fuer Payment Token.",
  ],
  [
    "de.private.section22.staking-income",
    "DE.BMF.2025-03-06.RN48",
    1,
    "Passives Staking als sonstige Einkuenfte.",
  ],
  [
    "de.private.section22.staking-income",
    "DE.BMF.2025-03-06.RN48A",
    2,
    "Claiming-Zeitpunkt als Vereinfachung.",
  ],
  [
    "de.private.section22.lending-income",
    "DE.BMF.2025-03-06.RN65",
    1,
    "Lending-Einkuenfte steuerbar nach section 22 number 3.",
  ],
  [
    "de.private.airdrop.section22-or-gift",
    "DE.BMF.2025-03-06.RN70",
    1,
    "Airdrop mit Leistung als sonstige Einkunft.",
  ],
  [
    "de.private.airdrop.section22-or-gift",
    "DE.BMF.2025-03-06.RN71",
    2,
    "Datenueberlassung kann Leistung sein.",
  ],
  [
    "de.private.airdrop.section22-or-gift",
    "DE.BMF.2025-03-06.RN72",
    3,
    "Zufall kann Leistungszusammenhang entkraeften.",
  ],
  [
    "de.private.airdrop.section22-or-gift",
    "DE.BMF.2025-03-06.RN73",
    4,
    "Airdrop-Bewertung inkl. 0-Euro-Fallback.",
  ],
  [
    "de.private.airdrop.section22-or-gift",
    "DE.BMF.2025-03-06.RN74",
    5,
    "Ohne Leistung kann Schenkung vorliegen.",
  ],
  [
    "de.private.airdrop.section22-or-gift",
    "DE.BMF.2025-03-06.RN75",
    6,
    "Leistungs-Airdrop begruendet Anschaffung.",
  ],
  [
    "de.private.hard-fork.section23-follow-up-sale",
    "DE.BMF.2025-03-06.RN68",
    1,
    "Hard Fork selbst kein section-22-Ereignis.",
  ],
  [
    "de.private.hard-fork.section23-follow-up-sale",
    "DE.BMF.2025-03-06.RN53",
    2,
    "Folgeveraeusserung unter section 23 pruefen.",
  ],
  [
    "de.valuation.market-price-and-daily-rate",
    "DE.BMF.2025-03-06.RN43",
    1,
    "Marktkurs am Anschaffungszeitpunkt.",
  ],
  [
    "de.valuation.market-price-and-daily-rate",
    "DE.BMF.2025-03-06.RN91",
    2,
    "Tageskurse nur bei konsistenter Methodik.",
  ],
  [
    "de.compliance.recordkeeping-and-mitwirkung",
    "DE.BMF.2025-03-06.RN87",
    1,
    "Public key allein reicht nicht.",
  ],
  [
    "de.compliance.recordkeeping-and-mitwirkung",
    "DE.BMF.2025-03-06.RN89",
    2,
    "Erweiterte Mitwirkungspflichten.",
  ],
  [
    "de.compliance.recordkeeping-and-mitwirkung",
    "DE.BMF.2025-03-06.RN90",
    3,
    "Steuerreports nur bei Plausibilitaet.",
  ],
  [
    "de.compliance.recordkeeping-and-mitwirkung",
    "DE.BMF.2025-03-06.RN92",
    4,
    "Schaetzung bei unzureichenden Angaben.",
  ],
  [
    "de.compliance.recordkeeping-and-mitwirkung",
    "DE.BMF.2025-03-06.RN101",
    5,
    "Unterlagen muessen anforderbar sein.",
  ],
  [
    "de.compliance.recordkeeping-and-mitwirkung",
    "DE.BMF.2025-03-06.RN102",
    6,
    "Strukturierte Uebersichten erforderlich.",
  ],
  [
    "de.compliance.recordkeeping-and-mitwirkung",
    "DE.BMF.2025-03-06.RN103",
    7,
    "Kursquelle und Methodenwahl dokumentieren.",
  ],
  [
    "de.compliance.recordkeeping-and-mitwirkung",
    "DE.BMF.2025-03-06.RN104",
    8,
    "Wallet-/Hash-Nachweise koennen verlangt werden.",
  ],
  [
    "de.compliance.recordkeeping-and-mitwirkung",
    "DE.BMF.2025-03-06.RN105",
    9,
    "Aufbewahrungspflichten bei hohen Einkuenften.",
  ],
  [
    "de.transition.application-rule",
    "DE.BMF.2025-03-06.RN106",
    1,
    "Anwendungs- und Uebergangsregel.",
  ],
] as const

const transactionTypeLegalRules = [
  [
    "swap_crypto_to_crypto",
    "de.private.section23.disposal-within-one-year",
    "1.00",
    "Krypto-zu-Krypto-Tausch als Veraeusserungsvorgang",
  ],
  [
    "sell_fiat",
    "de.private.section23.disposal-within-one-year",
    "1.00",
    "Fiat-Verkauf innerhalb/ausserhalb Haltefrist bewerten",
  ],
  [
    "payment_sent",
    "de.private.section23.disposal-within-one-year",
    "0.98",
    "Bezahlung mit Krypto als Veraeusserung behandeln",
  ],
  [
    "internal_transfer",
    "de.compliance.recordkeeping-and-mitwirkung",
    "0.95",
    "Interner Transfer nur mit belegbarer Wallet-Verknuepfung",
  ],
  [
    "staking_reward",
    "de.private.section22.staking-income",
    "1.00",
    "Staking-Ertrag als sonstige Einkuenfte inkl. Claiming-Hinweis",
  ],
  [
    "interest_received",
    "de.private.section22.lending-income",
    "1.00",
    "Lending-/Zins-Eingang als sonstige Einkuenfte",
  ],
  [
    "airdrop",
    "de.private.airdrop.section22-or-gift",
    "1.00",
    "Airdrop-Branching Leistung/Zufall/Schenkung",
  ],
  [
    "fork_income",
    "de.private.hard-fork.section23-follow-up-sale",
    "0.90",
    "Hard Fork selbst kein section-22-Ereignis, Folgeveraeusserung section 23",
  ],
] as const

/**
 * Seed reference rows required by a fresh Solana-focused TaxMaxi database.
 */
export const seedSolanaReferenceData = Effect.gen(function* () {
  const db = yield* drizzle

  yield* db
    .insert(schema.blockchains)
    .values(
      blockchains.map((blockchain) => ({
        ...blockchain,
        createdAt: seedTimestamp,
        updatedAt: seedTimestamp,
      }))
    )
    .onConflictDoNothing({ target: schema.blockchains.name })

  const [solanaBlockchain] = yield* db
    .select({ id: schema.blockchains.id })
    .from(schema.blockchains)
    .where(eq(schema.blockchains.name, "solana"))
    .limit(1)

  if (solanaBlockchain === undefined) {
    return yield* Effect.dieMessage("Missing solana blockchain after seeding blockchains")
  }

  const [existingNativeSolAsset] = yield* db
    .select({ id: schema.assets.id })
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.blockchainId, solanaBlockchain.id),
        eq(schema.assets.symbol, solanaNativeAsset.symbol),
        eq(schema.assets.type, solanaNativeAsset.type),
        isNull(schema.assets.contractAddress)
      )
    )
    .limit(1)

  if (existingNativeSolAsset === undefined) {
    yield* db.insert(schema.assets).values({
      ...solanaNativeAsset,
      blockchainId: solanaBlockchain.id,
      createdAt: seedTimestamp,
      updatedAt: seedTimestamp,
    })
  } else {
    yield* db
      .update(schema.assets)
      .set({
        name: solanaNativeAsset.name,
        decimals: solanaNativeAsset.decimals,
        logoUrl: solanaNativeAsset.logoUrl,
        isSpam: solanaNativeAsset.isSpam,
        updatedAt: seedTimestamp,
      })
      .where(eq(schema.assets.id, existingNativeSolAsset.id))
  }

  yield* db
    .insert(schema.assets)
    .values(
      solanaTokenAssets.map((asset) => ({
        ...asset,
        blockchainId: solanaBlockchain.id,
        createdAt: seedTimestamp,
        updatedAt: seedTimestamp,
      }))
    )
    .onConflictDoUpdate({
      target: [schema.assets.blockchainId, schema.assets.contractAddress],
      set: {
        name: sql.raw("excluded.name"),
        symbol: sql.raw("excluded.symbol"),
        decimals: sql.raw("excluded.decimals"),
        logoUrl: sql.raw("excluded.logo_url"),
        type: sql.raw("excluded.type"),
        isSpam: sql.raw("excluded.is_spam"),
        updatedAt: seedTimestamp,
      },
    })

  yield* db
    .insert(schema.cex)
    .values(
      cexRows.map((cex) => ({
        ...cex,
        logoUrl: null,
        createdAt: seedTimestamp,
        updatedAt: seedTimestamp,
      }))
    )
    .onConflictDoNothing({ target: schema.cex.name })

  yield* db
    .insert(schema.transactionCategories)
    .values(
      transactionCategories.map(([categoryKey, nameEn, nameDe]) => ({
        categoryKey,
        nameEn,
        nameDe,
        createdAt: seedTimestamp,
        updatedAt: seedTimestamp,
      }))
    )
    .onConflictDoNothing({ target: schema.transactionCategories.categoryKey })

  yield* db
    .insert(schema.transactionSubcategories)
    .values(
      transactionSubcategories.map(([subcategoryKey, nameEn, nameDe]) => ({
        subcategoryKey,
        nameEn,
        nameDe,
        createdAt: seedTimestamp,
        updatedAt: seedTimestamp,
      }))
    )
    .onConflictDoNothing({ target: schema.transactionSubcategories.subcategoryKey })

  yield* db
    .insert(schema.transactionTypes)
    .values(
      transactionTypes.map(([typeKey, categoryKey, subcategoryKey, labelEn, labelDe]) => ({
        typeKey,
        categoryKey,
        subcategoryKey,
        labelEn,
        labelDe,
        createdAt: seedTimestamp,
        updatedAt: seedTimestamp,
      }))
    )
    .onConflictDoNothing({ target: schema.transactionTypes.typeKey })

  yield* db
    .insert(schema.legalSources)
    .values({
      ...legalSource,
      createdAt: seedTimestamp,
      updatedAt: seedTimestamp,
    })
    .onConflictDoUpdate({
      target: schema.legalSources.sourceKey,
      set: {
        ...legalSource,
        updatedAt: seedTimestamp,
      },
    })

  const [legalSourceRow] = yield* db
    .select({ id: schema.legalSources.id })
    .from(schema.legalSources)
    .where(eq(schema.legalSources.sourceKey, legalSource.sourceKey))
    .limit(1)

  if (legalSourceRow === undefined) {
    return yield* Effect.dieMessage(`Missing legal source after seeding ${legalSource.sourceKey}`)
  }

  for (const clause of legalClauses) {
    yield* db
      .insert(schema.legalClauses)
      .values({
        ...clause,
        sourceId: legalSourceRow.id,
        createdAt: seedTimestamp,
        updatedAt: seedTimestamp,
      })
      .onConflictDoUpdate({
        target: schema.legalClauses.clauseKey,
        set: {
          ...clause,
          sourceId: legalSourceRow.id,
          updatedAt: seedTimestamp,
        },
      })
  }

  for (const rule of legalRules) {
    yield* db
      .insert(schema.legalRules)
      .values({
        ...rule,
        jurisdictionCode: "DE",
        isActive: true,
        createdAt: seedTimestamp,
        updatedAt: seedTimestamp,
      })
      .onConflictDoUpdate({
        target: schema.legalRules.ruleKey,
        set: {
          ...rule,
          jurisdictionCode: "DE",
          isActive: true,
          updatedAt: seedTimestamp,
        },
      })
  }

  yield* db
    .insert(schema.jurisdictionRuleSets)
    .values({
      ...jurisdictionRuleSet,
      createdAt: seedTimestamp,
      updatedAt: seedTimestamp,
    })
    .onConflictDoUpdate({
      target: [schema.jurisdictionRuleSets.jurisdictionCode, schema.jurisdictionRuleSets.version],
      set: {
        ...jurisdictionRuleSet,
        updatedAt: seedTimestamp,
      },
    })

  yield* db
    .update(schema.jurisdictionRuleSets)
    .set({
      isActive: false,
      updatedAt: seedTimestamp,
    })
    .where(
      and(
        eq(schema.jurisdictionRuleSets.jurisdictionCode, jurisdictionRuleSet.jurisdictionCode),
        ne(schema.jurisdictionRuleSets.version, jurisdictionRuleSet.version),
        eq(schema.jurisdictionRuleSets.isActive, true)
      )
    )

  yield* db
    .update(schema.jurisdictionRuleSets)
    .set({
      isActive: true,
      updatedAt: seedTimestamp,
    })
    .where(
      and(
        eq(schema.jurisdictionRuleSets.jurisdictionCode, jurisdictionRuleSet.jurisdictionCode),
        eq(schema.jurisdictionRuleSets.version, jurisdictionRuleSet.version)
      )
    )

  const [ruleSetRow] = yield* db
    .select({ id: schema.jurisdictionRuleSets.id })
    .from(schema.jurisdictionRuleSets)
    .where(
      and(
        eq(schema.jurisdictionRuleSets.jurisdictionCode, jurisdictionRuleSet.jurisdictionCode),
        eq(schema.jurisdictionRuleSets.version, jurisdictionRuleSet.version)
      )
    )
    .limit(1)

  if (ruleSetRow === undefined) {
    return yield* Effect.dieMessage(
      `Missing jurisdiction rule set after seeding ${jurisdictionRuleSet.version}`
    )
  }

  const legalRuleRows = yield* db
    .select({
      id: schema.legalRules.id,
      ruleKey: schema.legalRules.ruleKey,
    })
    .from(schema.legalRules)
    .where(
      inArray(
        schema.legalRules.ruleKey,
        legalRules.map((rule) => rule.ruleKey)
      )
    )

  const legalRuleIdsByKey = new Map(legalRuleRows.map((row) => [row.ruleKey, row.id] as const))

  for (const [ruleKey, priority] of jurisdictionRuleSetRules) {
    const ruleId = legalRuleIdsByKey.get(ruleKey)
    if (ruleId === undefined) {
      return yield* Effect.dieMessage(`Missing legal rule after seeding ${ruleKey}`)
    }

    yield* db
      .insert(schema.jurisdictionRuleSetRules)
      .values({
        ruleSetId: ruleSetRow.id,
        ruleId,
        priority,
        createdAt: seedTimestamp,
        updatedAt: seedTimestamp,
      })
      .onConflictDoUpdate({
        target: [schema.jurisdictionRuleSetRules.ruleSetId, schema.jurisdictionRuleSetRules.ruleId],
        set: {
          priority,
          updatedAt: seedTimestamp,
        },
      })
  }

  const legalClauseRows = yield* db
    .select({
      id: schema.legalClauses.id,
      clauseKey: schema.legalClauses.clauseKey,
    })
    .from(schema.legalClauses)
    .where(
      inArray(
        schema.legalClauses.clauseKey,
        legalClauses.map((clause) => clause.clauseKey)
      )
    )

  const legalClauseIdsByKey = new Map(
    legalClauseRows.map((row) => [row.clauseKey, row.id] as const)
  )

  for (const [ruleKey, clauseKey, citationOrder, quote] of legalRuleCitations) {
    const ruleId = legalRuleIdsByKey.get(ruleKey)
    if (ruleId === undefined) {
      return yield* Effect.dieMessage(`Missing legal rule for citation ${ruleKey}`)
    }

    const clauseId = legalClauseIdsByKey.get(clauseKey)
    if (clauseId === undefined) {
      return yield* Effect.dieMessage(`Missing legal clause for citation ${clauseKey}`)
    }

    yield* db
      .insert(schema.legalRuleCitations)
      .values({
        ruleId,
        clauseId,
        citationOrder,
        quote,
        createdAt: seedTimestamp,
        updatedAt: seedTimestamp,
      })
      .onConflictDoUpdate({
        target: [schema.legalRuleCitations.ruleId, schema.legalRuleCitations.clauseId],
        set: {
          citationOrder,
          quote,
          updatedAt: seedTimestamp,
        },
      })
  }

  for (const [transactionTypeKey, ruleKey, relevance, notes] of transactionTypeLegalRules) {
    const ruleId = legalRuleIdsByKey.get(ruleKey)
    if (ruleId === undefined) {
      return yield* Effect.dieMessage(`Missing legal rule for transaction type ${ruleKey}`)
    }

    yield* db
      .insert(schema.transactionTypeLegalRules)
      .values({
        transactionTypeKey,
        ruleId,
        relevance,
        notes,
        createdAt: seedTimestamp,
        updatedAt: seedTimestamp,
      })
      .onConflictDoUpdate({
        target: [
          schema.transactionTypeLegalRules.transactionTypeKey,
          schema.transactionTypeLegalRules.ruleId,
        ],
        set: {
          relevance,
          notes,
          updatedAt: seedTimestamp,
        },
      })
  }
})
