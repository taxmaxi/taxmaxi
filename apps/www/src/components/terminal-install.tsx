import CopyButton from "./copy-button"

export default function TerminalInstall() {
  return (
    <div className="relative w-full max-w-md mx-auto">
      <div className="rounded-xl border border-[#2a3a35] bg-[#0d1210] shadow-2xl shadow-black/40 overflow-hidden">
        {/* Title bar */}
        <div className="flex items-center gap-2 px-4 py-3 bg-[#151a18] border-b border-[#2a3a35]">
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-full bg-[#ff5f57]" />
            <div className="w-3 h-3 rounded-full bg-[#febc2e]" />
            <div className="w-3 h-3 rounded-full bg-[#28c840]" />
          </div>
        </div>
        {/* Terminal body */}
        <div className="px-5 py-4 font-mono text-sm space-y-3">
          <div>
            <p className="text-[#8ab4a3]/40"># Install the TaxMaxi CLI</p>
            <div className="flex items-center justify-between">
              <p>
                <span className="text-[#28c840]">$</span>{" "}
                <span className="text-[#a3c4b5]">npm i -g tax</span>
              </p>
              <CopyButton text="npm i -g tax" />
            </div>
          </div>
          <div>
            <p className="text-[#8ab4a3]/40"># Calculate your crypto taxes</p>
            <div className="flex items-center justify-between">
              <p>
                <span className="text-[#28c840]">$</span>{" "}
                <span className="text-[#a3c4b5]">tax vitalik.eth</span>
              </p>
              <CopyButton text="tax" />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
