import { HeadContent, Scripts, createRootRouteWithContext } from "@tanstack/react-router"
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools"
import { TanStackDevtools } from "@tanstack/react-devtools"
import type { QueryClient } from "@tanstack/react-query"

import { DefaultCatchBoundary } from "../components/catch-boundary"
import { NotFound } from "../components/not-found"
import TanStackQueryDevtools from "../integrations/tanstack-query/devtools"
import StoreDevtools from "../lib/demo-store-devtools"
import { seo } from "../lib/seo"
import PostHogProvider from "../integrations/posthog/provider"
import stylesCss from "../styles.css?url"

interface MyRouterContext {
  queryClient: QueryClient
}

const THEME_INIT_SCRIPT = `(function(){try{var stored=window.localStorage.getItem('theme');var mode=(stored==='light'||stored==='dark'||stored==='auto')?stored:'auto';var prefersDark=window.matchMedia('(prefers-color-scheme: dark)').matches;var resolved=mode==='auto'?(prefersDark?'dark':'light'):mode;var root=document.documentElement;root.classList.remove('light','dark');root.classList.add(resolved);if(mode==='auto'){root.removeAttribute('data-theme')}else{root.setAttribute('data-theme',mode)}root.style.colorScheme=resolved;}catch(e){}})();`

export const Route = createRootRouteWithContext<MyRouterContext>()({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      ...seo({
        title: "TaxMaxi",
        description: "TaxMaxi | The Crypto Tax API",
        image: {
          url: "https://www.taxmaxi.com/og-image.png",
          type: "image/png",
          width: "1200",
          height: "630",
          alt: "TaxMaxi | The Crypto Tax API",
        },
      }),
    ],
    links: [
      { rel: "stylesheet", href: stylesCss },
      {
        rel: "apple-touch-icon",
        sizes: "180x180",
        href: "/apple-touch-icon.png",
      },
      {
        rel: "icon",
        type: "image/png",
        sizes: "64x64",
        href: "/favicon-64x64.png",
      },
      { rel: "manifest", href: "/site.webmanifest", color: "#F7F0E3" },
      { rel: "icon", href: "/favicon.ico" },
    ],
  }),
  errorComponent: (props) => {
    return (
      <RootDocument>
        <DefaultCatchBoundary {...props} />
      </RootDocument>
    )
  },
  notFoundComponent: () => <NotFound />,
  shellComponent: RootDocument,
})

function Providers({ children }: { children: React.ReactNode }): React.ReactNode {
  if (import.meta.env.DEV) return children

  return <PostHogProvider>{children}</PostHogProvider>
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <HeadContent />
      </head>
      <body>
        <Providers>
          {children}
          <TanStackDevtools
            config={{
              position: "bottom-right",
            }}
            plugins={[
              {
                name: "Tanstack Router",
                render: <TanStackRouterDevtoolsPanel />,
              },
              TanStackQueryDevtools,
              StoreDevtools,
            ]}
          />
        </Providers>
        <Scripts />
      </body>
    </html>
  )
}
