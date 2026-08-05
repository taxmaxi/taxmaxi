/// <reference types="vite/client" />
interface ViteTypeOptions {
  strictImportMetaEnv: unknown
}

interface ImportMetaEnv {
  readonly VITE_TAXMAXI_API_BASE_URL?: string
  readonly VITE_POSTHOG_KEY?: string
  readonly VITE_POSTHOG_HOST?: string
  readonly VITE_ENABLED_MOCKS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
