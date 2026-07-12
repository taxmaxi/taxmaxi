import { Check, CircleX } from "lucide-react"
import { motion } from "motion/react"

import type { SourceSyncPhase, SourceSyncStatus } from "#/components/source-sync-island"

const ORB = {
  center: 16,
  radius: 12.5,
  strokeWidth: 4,
  normalizedLength: 100,
  queuedDash: "0.05 0.11",
}

const DISCOVERY_PROGRESS = {
  strokeDashoffsets: [100, 80, 65, 55, 50.5],
  times: [0, 1 / 60, 1 / 12, 7 / 30, 1],
}

const REDUCED_TRANSITION = { duration: 0 }
const EASE_OUT = [0.22, 1, 0.36, 1] as const

export function SourceSyncStatusOrb({
  phase,
  progress,
  reduceMotion,
  status,
}: {
  phase: SourceSyncPhase | undefined
  progress: number
  reduceMotion: boolean
  status: SourceSyncStatus
}) {
  const progressVisible = status === "running" || status === "completed"
  const determinate = status === "running"
  const estimated = phase === "discovering"
  const completed = status === "completed"

  return (
    <span
      aria-label={
        determinate ? (estimated ? "Estimated sync progress" : "Sync progress") : undefined
      }
      aria-valuemax={determinate ? 100 : undefined}
      aria-valuemin={determinate ? 0 : undefined}
      aria-valuenow={determinate && !estimated ? Math.round(progress) : undefined}
      aria-valuetext={estimated ? "Discovering transactions" : undefined}
      className="relative grid size-5 shrink-0 place-items-center rounded-full"
      role={determinate ? "progressbar" : undefined}
    >
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 size-full"
        viewBox="0 0 32 32"
      >
        {status === "queued" ? (
          <circle
            className="fill-none stroke-white"
            cx={ORB.center}
            cy={ORB.center}
            pathLength="1"
            r={ORB.radius}
            strokeDasharray={ORB.queuedDash}
            strokeLinecap="round"
            strokeWidth={ORB.strokeWidth}
          />
        ) : null}
        {progressVisible ? (
          <>
            <motion.circle
              animate={{ opacity: completed ? 0 : 1 }}
              className="fill-none stroke-white/20"
              cx={ORB.center}
              cy={ORB.center}
              initial={false}
              r={ORB.radius}
              strokeWidth={ORB.strokeWidth}
              transition={getSuccessTransition(reduceMotion)}
            />
            <motion.circle
              animate={{
                opacity: completed ? 0 : 1,
                strokeDashoffset:
                  estimated && !reduceMotion
                    ? DISCOVERY_PROGRESS.strokeDashoffsets
                    : ORB.normalizedLength - progress,
              }}
              className="fill-none stroke-white"
              cx={ORB.center}
              cy={ORB.center}
              initial={reduceMotion ? false : { strokeDashoffset: ORB.normalizedLength }}
              pathLength={ORB.normalizedLength}
              r={ORB.radius}
              strokeDasharray={`${ORB.normalizedLength} ${ORB.normalizedLength}`}
              strokeLinecap="round"
              strokeWidth={ORB.strokeWidth}
              transform={`rotate(-90 ${ORB.center} ${ORB.center})`}
              transition={
                completed
                  ? getSuccessTransition(reduceMotion)
                  : getOrbTransition({ phase, reduceMotion })
              }
            />
          </>
        ) : null}
      </svg>

      <span className="relative grid size-5 place-items-center rounded-full">
        <motion.span
          animate={completed ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.82 }}
          className="absolute inset-0 grid place-items-center rounded-full bg-green-500"
          initial={false}
          transition={getSuccessTransition(reduceMotion)}
        >
          <Check aria-hidden="true" className="size-3 text-white" strokeWidth={4} />
        </motion.span>
        {status === "failed" ? (
          <CircleX
            aria-hidden="true"
            className="size-4.5 text-sync-island-failed"
            strokeWidth={3}
          />
        ) : null}
      </span>
    </span>
  )
}

function getOrbTransition({
  phase,
  reduceMotion,
}: {
  phase: SourceSyncPhase | undefined
  reduceMotion: boolean
}) {
  if (reduceMotion) {
    return REDUCED_TRANSITION
  }

  if (phase === "discovering") {
    return {
      duration: 300,
      ease: "linear" as const,
      times: DISCOVERY_PROGRESS.times,
    }
  }

  return { duration: 0.45, ease: EASE_OUT }
}

function getSuccessTransition(reduceMotion: boolean) {
  return reduceMotion ? REDUCED_TRANSITION : { duration: 0.18, ease: EASE_OUT }
}
