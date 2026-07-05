const TX_CARDS = [
  {
    label: "Normal Tx",
    color: "#627eea",
    json: [
      { key: "hash", val: "0x0ff3…2326" },
      { key: "from", val: "0xc3ae…eb31" },
      { key: "to", val: "0xc02a…6cc2" },
      { key: "value", val: "250000000000000000" },
      { key: "functionName", val: "deposit()" },
    ],
  },
  {
    label: "ERC-20 Transfer",
    color: "#f7931a",
    json: [
      { key: "hash", val: "0xf394…e9c9" },
      { key: "from", val: "0x74de…6631" },
      { key: "tokenSymbol", val: "TURBO" },
      { key: "value", val: "2078725968…7494" },
      { key: "functionName", val: "swap(…)" },
    ],
  },
  {
    label: "Internal Tx",
    color: "#14f195",
    json: [
      { key: "hash", val: "0xa52d…d9ea" },
      { key: "from", val: "0x1522…e428" },
      { key: "to", val: "0xc3ae…eb31" },
      { key: "value", val: "500000000000000000" },
      { key: "type", val: "call" },
    ],
  },
]

const LEDGER_ROWS = [
  { type: "DEPOSIT", detail: "0.25 ETH → WETH" },
  { type: "SWAP", detail: "2,078.7 TURBO received" },
  { type: "TRANSFER", detail: "0.5 ETH received" },
]

const STYLE = `
  @keyframes ing-card-v {
    from { opacity: 0; transform: translate(calc(var(--x, 0px) - 6px), -8px); }
    to   { opacity: 1; transform: translate(var(--x, 0px), 0); }
  }
  @keyframes ing-card-h {
    from { opacity: 0; transform: translateX(calc(var(--x, 0px) - 10px)); }
    to   { opacity: 1; transform: translateX(var(--x, 0px)); }
  }
  @keyframes ing-ledger-v {
    from { opacity: 0; transform: translateY(10px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes ing-ledger-h {
    from { opacity: 0; transform: translateX(10px); }
    to   { opacity: 1; transform: translateX(0); }
  }
  @keyframes ing-flow {
    0%, 100% { opacity: 0.12; }
    50%      { opacity: 0.6; }
  }

  .ing-card-0 { animation: ing-card-v 0.35s ease-out 0s both; }
  .ing-card-1 { animation: ing-card-v 0.35s ease-out 0.1s both; }
  .ing-card-2 { animation: ing-card-v 0.35s ease-out 0.2s both; }
  .ing-ledger  { animation: ing-ledger-v 0.35s ease-out 0.3s both; }

  @media (min-width: 640px) {
    .ing-card-0 { animation-name: ing-card-h; }
    .ing-card-1 { animation-name: ing-card-h; }
    .ing-card-2 { animation-name: ing-card-h; }
    .ing-ledger  { animation-name: ing-ledger-h; }
  }
`

export function IngestionGraph() {
  return (
    <div className="relative w-full">
      <style>{STYLE}</style>

      <div className="flex w-full flex-col items-center gap-5 sm:grid sm:grid-cols-[1fr_auto_1fr] sm:items-center sm:gap-x-12">
        {/* Raw data cards — z-stacked */}
        <div className="relative w-full max-w-xs -translate-x-3 sm:max-w-none sm:translate-x-0">
          {TX_CARDS.map((card, i) => (
            <div
              key={card.label}
              className={`ing-card-${i} relative overflow-hidden rounded-lg border border-[#2a3a35] bg-[#0f1614]`}
              style={
                {
                  "--x": `${i * 12}px`,
                  zIndex: i + 1,
                  marginTop: i > 0 ? "-5.5rem" : undefined,
                  boxShadow: "0 4px 24px -6px rgba(0,0,0,0.5)",
                } as React.CSSProperties
              }
            >
              <div className="flex items-center gap-2 border-b border-[#2a3a35]/50 px-3.5 py-1.5">
                <div className="h-2 w-2 rounded-full" style={{ backgroundColor: card.color }} />
                <span className="text-[10px] uppercase tracking-[0.15em] text-[#6b9484]">
                  {card.label}
                </span>
              </div>
              <div className="px-3.5 py-2.5 text-[11px] leading-[1.7]">
                <span className="text-off-white/15">{"{"}</span>
                {card.json.map((f, fi) => (
                  <div key={f.key} className="pl-3.5">
                    <span className="text-[#8ab4a3]/50">&quot;{f.key}&quot;</span>
                    <span className="text-off-white/15">: </span>
                    <span className="text-off-white/45">&quot;{f.val}&quot;</span>
                    {fi < card.json.length - 1 && <span className="text-off-white/15">,</span>}
                  </div>
                ))}
                <span className="text-off-white/15">{"}"}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Flow arrows — rotated down on mobile, horizontal on desktop */}
        <div className="flex items-center justify-center gap-5 sm:flex-col">
          {[0, 1, 2].map((i) => (
            <svg
              key={i}
              width="24"
              height="12"
              viewBox="0 0 24 12"
              fill="none"
              className="rotate-90 sm:rotate-0"
              style={{ animation: `ing-flow 1.5s ease-in-out ${i * 0.3}s infinite` }}
            >
              <path
                d="M0 6H20M16 2L20 6L16 10"
                stroke="#8ab4a3"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ))}
        </div>

        {/* Unified ledger */}
        <div className="ing-ledger w-full self-center overflow-hidden rounded-lg border border-[#2a3a35] bg-[#131917] sm:w-auto">
          <div className="border-b border-[#2a3a35]/60 px-4 py-2">
            <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-[#6b9484]">
              Unified Ledger
            </span>
          </div>
          <div className="divide-y divide-[#2a3a35]/30">
            {LEDGER_ROWS.map((row) => (
              <div key={row.type} className="flex items-center gap-2.5 px-4 py-3">
                <span className="inline-flex items-center justify-center rounded bg-[#8ab4a3]/10 px-2 py-1 text-[10px] font-bold uppercase text-[#8ab4a3]">
                  {row.type}
                </span>
                <span className="whitespace-nowrap text-[12px] text-off-white/50">
                  {row.detail}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
