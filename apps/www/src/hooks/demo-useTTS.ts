import { useCallback, useRef, useState } from "react"
import { z } from "zod"

import { getJsonErrorMessage } from "#/lib/demo-ai-json"

const TTSResponseSchema = z.object({
  audio: z.string(),
  contentType: z.string(),
})

/**
 * Hook for text-to-speech playback via the TTS API.
 */
export function useTTS() {
  const [playingId, setPlayingId] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const speak = useCallback(async (text: string, id: string) => {
    // Stop any currently playing audio
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }

    setPlayingId(id)

    try {
      const response = await fetch("/demo/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          voice: "nova",
          model: "tts-1",
          format: "mp3",
        }),
      })

      if (!response.ok) {
        const errorData: unknown = await response.json()
        throw new Error(getJsonErrorMessage(errorData, "TTS failed"))
      }

      const result = TTSResponseSchema.parse(await response.json())

      // Convert base64 to audio and play
      const audioData = atob(result.audio)
      const bytes = new Uint8Array(audioData.length)
      for (let i = 0; i < audioData.length; i++) {
        bytes[i] = audioData.charCodeAt(i)
      }
      const blob = new Blob([bytes], { type: result.contentType })
      const url = URL.createObjectURL(blob)

      const audio = new Audio(url)
      audioRef.current = audio

      audio.onended = () => {
        URL.revokeObjectURL(url)
        setPlayingId(null)
        audioRef.current = null
      }

      audio.onerror = () => {
        URL.revokeObjectURL(url)
        setPlayingId(null)
        audioRef.current = null
      }

      await audio.play()
    } catch (error) {
      console.error("TTS error:", error)
      setPlayingId(null)
    }
  }, [])

  const stop = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    setPlayingId(null)
  }, [])

  return { playingId, speak, stop }
}
