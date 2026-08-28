let sequence = 0

export const nextTestUuid = (): string => {
  sequence += 1
  return `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`
}
