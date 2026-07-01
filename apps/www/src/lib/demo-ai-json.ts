export function getJsonErrorMessage(data: unknown, fallback: string) {
  if (typeof data === "object" && data !== null && "error" in data) {
    const { error } = data
    if (typeof error === "string" && error.length > 0) {
      return error
    }
  }

  return fallback
}

export function getCaughtErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.length > 0) {
    return error.message
  }

  if (typeof error === "string" && error.length > 0) {
    return error
  }

  return fallback
}
