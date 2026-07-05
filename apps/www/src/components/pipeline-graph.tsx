import { useLayoutEffect, useRef, useState } from "react"

import AustriaFlag from "#/components/ui/icons/countries/at.svg"
import SwitzerlandFlag from "#/components/ui/icons/countries/ch.svg"
import GermanyFlag from "#/components/ui/icons/countries/de.svg"
import UKFlag from "#/components/ui/icons/countries/en.svg"
import FranceFlag from "#/components/ui/icons/countries/fr.svg"
import USAFlag from "#/components/ui/icons/countries/us.svg"
import BinanceLogo from "#/components/ui/logos/binance.svg"
import BitcoinLogo from "#/components/ui/logos/bitcoin.svg"
import CoinbaseLogo from "#/components/ui/logos/coinbase/coinbase-blue.svg"
import EthereumLogo from "#/components/ui/logos/ethereum.svg"
import KrakenLogo from "#/components/ui/logos/kraken.svg"
import SolanaLogo from "#/components/ui/logos/solana.svg"
import TaxMaxiLogo from "#/components/ui/logos/taxmaxi-dark.svg"

const sources = [
  { name: "Ethereum", logo: EthereumLogo },
  { name: "Bitcoin", logo: BitcoinLogo },
  { name: "Solana", logo: SolanaLogo },
  { name: "Binance", logo: BinanceLogo },
  { name: "Coinbase", logo: CoinbaseLogo },
  { name: "Kraken", logo: KrakenLogo },
]

const destinations = [
  { name: "Germany", flag: GermanyFlag },
  { name: "Austria", flag: AustriaFlag },
  { name: "Switzerland", flag: SwitzerlandFlag },
  { name: "France", flag: FranceFlag },
  { name: "USA", flag: USAFlag },
  { name: "United Kingdom", flag: UKFlag },
]

export function PipelineGraph() {
  const containerRef = useRef<HTMLDivElement>(null)
  const sourceRefs = useRef<(HTMLDivElement | null)[]>([])
  const hubRef = useRef<HTMLDivElement>(null)
  const destRefs = useRef<(HTMLDivElement | null)[]>([])
  const [paths, setPaths] = useState<string[]>([])

  useLayoutEffect(() => {
    function calculate() {
      const container = containerRef.current
      const hub = hubRef.current
      if (!container || !hub) return

      const cr = container.getBoundingClientRect()
      const hr = hub.getBoundingClientRect()
      const hubCy = hr.top + hr.height / 2 - cr.top
      const hubLeft = hr.left - cr.left
      const hubRight = hr.right - cr.left

      const result: string[] = []

      for (const el of sourceRefs.current) {
        if (!el) continue
        const r = el.getBoundingClientRect()
        const x1 = r.right - cr.left
        const y1 = r.top + r.height / 2 - cr.top
        const x2 = hubLeft
        const y2 = hubCy
        const cpx = (x1 + x2) / 2
        result.push(`M ${x1} ${y1} C ${cpx} ${y1}, ${cpx} ${y2}, ${x2} ${y2}`)
      }

      for (const el of destRefs.current) {
        if (!el) continue
        const r = el.getBoundingClientRect()
        const x1 = hubRight
        const y1 = hubCy
        const x2 = r.left - cr.left
        const y2 = r.top + r.height / 2 - cr.top
        const cpx = (x1 + x2) / 2
        result.push(`M ${x1} ${y1} C ${cpx} ${y1}, ${cpx} ${y2}, ${x2} ${y2}`)
      }

      setPaths(result)
    }

    calculate()

    const observer = new ResizeObserver(calculate)
    if (containerRef.current) observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [])

  return (
    <div className="relative w-full">
      <style>{`
        @keyframes pipeline-flow {
          from { stroke-dashoffset: 24; }
          to { stroke-dashoffset: 0; }
        }
      `}</style>

      {/* Pipeline grid — labels excluded so hub centers against pills only */}
      <div ref={containerRef} className="relative">
        {/* Connection lines */}
        <svg className="absolute inset-0 w-full h-full pointer-events-none overflow-visible">
          <defs>
            <linearGradient id="pipeGrad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#8ab4a3" stopOpacity="0.1" />
              <stop offset="50%" stopColor="#8ab4a3" stopOpacity="0.35" />
              <stop offset="100%" stopColor="#8ab4a3" stopOpacity="0.1" />
            </linearGradient>
          </defs>
          {paths.map((d, i) => (
            <g key={i}>
              <path d={d} fill="none" stroke="url(#pipeGrad)" strokeWidth="1.5" />
              <path
                d={d}
                fill="none"
                stroke="#8ab4a3"
                strokeWidth="2"
                strokeOpacity="0.6"
                strokeDasharray="4 20"
                strokeLinecap="round"
                style={{
                  animation: "pipeline-flow 1s linear infinite",
                  animationDelay: `${i * 0.1}s`,
                }}
              />
            </g>
          ))}
        </svg>

        <div className="relative z-10 grid grid-cols-[1fr_auto_1fr] items-center gap-x-6 sm:gap-x-16 md:gap-x-32">
          {/* Sources */}
          <div className="flex flex-col gap-3 items-start">
            {sources.map((s, i) => (
              <div
                key={s.name}
                ref={(el) => {
                  sourceRefs.current[i] = el
                }}
              >
                <img src={s.logo} alt={s.name} className="size-8 shrink-0 object-contain" />
              </div>
            ))}
          </div>

          {/* Center hub */}
          <div ref={hubRef}>
            <img src={TaxMaxiLogo} alt="TaxMaxi" className="size-12 sm:size-16" />
          </div>

          {/* Destinations */}
          <div className="flex flex-col gap-3 items-end">
            {destinations.map((d, i) => (
              <div
                key={d.name}
                ref={(el) => {
                  destRefs.current[i] = el
                }}
              >
                <img src={d.flag} alt={d.name} className="size-8 rounded-full" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
