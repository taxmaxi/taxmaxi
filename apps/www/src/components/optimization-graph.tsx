const RECOMMENDATIONS = [
  {
    title: "Hold 47 more days",
    detail: "2.5 ETH becomes tax-free under §23 EStG",
    savings: "+€1,204",
  },
  {
    title: "Harvest SOL loss",
    detail: "Realize -€2,412 loss to offset current gains",
    savings: "+€723",
  },
  {
    title: "Deduct gas fees",
    detail: "89 transactions × avg €1.02 in gas",
    savings: "+€91",
  },
]

export function OptimizationGraph() {
  return (
    <div className="relative w-full">
      <style>{`
        @keyframes opt-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
        @keyframes opt-scan {
          0% { transform: translateX(-100%); opacity: 0; }
          5% { opacity: 1; }
          95% { opacity: 1; }
          100% { transform: translateX(400%); opacity: 0; }
        }
        @keyframes opt-enter {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      <div className="space-y-2">
        {/* Status header */}
        <div
          className="flex items-center gap-2 px-1 py-1"
          style={{ animation: "opt-enter 0.4s ease-out both" }}
        >
          <div className="flex h-4 w-4 items-center justify-center rounded-full bg-[#8ab4a3]/15">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path
                d="M2 5.5L4 7.5L8 3"
                stroke="#8ab4a3"
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <span className="text-[10px] text-[#6b9484]">
            Analysis complete · 3 optimizations found
          </span>
        </div>

        {/* Recommendation cards */}
        {RECOMMENDATIONS.map((rec, i) => (
          <div
            key={rec.title}
            className="relative overflow-hidden rounded-lg border border-[#2a3a35] bg-[#131917] px-3.5 py-2.5"
            style={{ animation: `opt-enter 0.4s ease-out ${0.1 + i * 0.1}s both` }}
          >
            {/* Ambient scan highlight */}
            <div
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  "linear-gradient(90deg, transparent, rgba(138,180,163,0.05), transparent)",
                animation: `opt-scan 4s ease-in-out ${1.5 + i * 0.7}s infinite`,
              }}
            />

            <div className="relative flex items-start justify-between gap-3">
              <div className="flex items-start gap-2.5">
                <div
                  className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#8ab4a3]"
                  style={{
                    animation: `opt-pulse 2.5s ease-in-out ${i * 0.4}s infinite`,
                  }}
                />
                <div>
                  <p className="text-[12px] font-medium leading-snug text-off-white">{rec.title}</p>
                  <p className="mt-0.5 text-[10px] text-[#6b9484]">{rec.detail}</p>
                </div>
              </div>

              <span className="mt-0.5 shrink-0 text-[12px] font-bold tabular-nums text-[#8ab4a3]">
                {rec.savings}
              </span>
            </div>
          </div>
        ))}

        {/* Total savings bar */}
        <div
          className="relative overflow-hidden rounded-lg border border-[#8ab4a3]/20 bg-[#8ab4a3]/4 px-3.5 py-2.5"
          style={{ animation: "opt-enter 0.4s ease-out 0.5s both" }}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="h-5 w-0.5 rounded-full bg-[#8ab4a3]" />
              <span className="text-[10px] font-medium uppercase tracking-[0.15em] text-[#8ab4a3]">
                Total savings potential
              </span>
            </div>
            <span className="text-base font-bold tabular-nums text-[#8ab4a3]">€2,018</span>
          </div>
        </div>
      </div>
    </div>
  )
}
