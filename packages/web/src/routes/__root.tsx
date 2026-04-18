import {
  Outlet,
  createRootRouteWithContext,
  HeadContent,
  Scripts,
  Link,
} from "@tanstack/react-router";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import type { ReactNode } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { Sun, Moon } from "lucide-react";
import appCss from "../styles/globals.css?url";
import { TaskEventsProvider } from "../lib/task-events-context";
import { MergeEventsProvider } from "../lib/merge-events-context";
import { ProjectEventsProvider } from "../lib/project-events-context";
import { ChildrenEventsProvider } from "../lib/children-events-context";
import { TodoEventsProvider } from "../lib/todo-events-context";
import { useTheme } from "../lib/use-theme";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "stylesheet", href: appCss },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@300..700&display=swap",
      },
    ],
  }),
  component: RootComponent,
  errorComponent: RootError,
  notFoundComponent: NotFound,
});

function RootComponent() {
  const { theme, toggle } = useTheme();

  return (
    <RootDocument>
      <TaskEventsProvider>
        <MergeEventsProvider>
          <ProjectEventsProvider>
            <ChildrenEventsProvider>
              <TodoEventsProvider>
                <div className="min-h-screen bg-bg-000">
                  <nav className="flex items-center gap-4 border-b border-border-300/50 px-6 py-2 text-sm">
                    <Link to="/" className="font-semibold text-text-100 hover:text-text-000">
                      WIP
                    </Link>
                    <Link
                      to="/queue"
                      className="text-text-300 hover:text-text-100 [&.active]:text-text-000 [&.active]:font-medium"
                    >
                      Queue
                    </Link>
                    <Link
                      to="/kanban"
                      className="text-text-300 hover:text-text-100 [&.active]:text-text-000 [&.active]:font-medium"
                    >
                      Kanban
                    </Link>
                    <Link
                      to="/snoozed"
                      className="text-text-300 hover:text-text-100 [&.active]:text-text-000 [&.active]:font-medium"
                    >
                      Snoozed
                    </Link>
                    <Link
                      to="/tasks"
                      className="text-text-300 hover:text-text-100 [&.active]:text-text-000 [&.active]:font-medium"
                    >
                      Tasks
                    </Link>
                    <Link
                      to="/states"
                      className="text-text-300 hover:text-text-100 [&.active]:text-text-000 [&.active]:font-medium"
                    >
                      States
                    </Link>
                    <Link
                      to="/debug/logs"
                      className="text-text-300 hover:text-text-100 [&.active]:text-text-000 [&.active]:font-medium"
                    >
                      Logs
                    </Link>
                    <button
                      type="button"
                      onClick={toggle}
                      className="ml-auto rounded p-1.5 text-text-400 transition-colors hover:bg-bg-200 hover:text-text-100"
                      title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
                    >
                      {theme === "dark" ? (
                        <Sun className="h-4 w-4" />
                      ) : (
                        <Moon className="h-4 w-4" />
                      )}
                    </button>
                  </nav>
                  <Outlet />
                </div>
              </TodoEventsProvider>
            </ChildrenEventsProvider>
          </ProjectEventsProvider>
        </MergeEventsProvider>
      </TaskEventsProvider>
    </RootDocument>
  );
}

function RootError({ error }: { error: unknown }) {
  return (
    <RootDocument>
      <div className="min-h-screen bg-bg-000 p-8">
        <div className="mx-auto max-w-2xl">
          <h1 className="text-lg font-semibold text-red-600 dark:text-red-400">
            Something went wrong
          </h1>
          <pre className="mt-4 overflow-auto rounded-lg bg-bg-200 p-4 font-mono text-sm text-text-200">
            {error instanceof Error ? error.message : String(error)}
          </pre>
        </div>
      </div>
    </RootDocument>
  );
}

function NotFound() {
  return (
    <div className="p-8">
      <h1 className="text-lg font-semibold">404 &mdash; Not Found</h1>
    </div>
  );
}

const themeScript = `(function(){try{var t=localStorage.getItem('theme');var d=document.documentElement;if(t==='dark')d.classList.add('dark');else if(t==='light')d.classList.add('light');else{d.classList.add(window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light')}}catch(e){}})()`;

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <HeadContent />
      </head>
      <body>
        {children}
        <ReactQueryDevtools buttonPosition="bottom-left" />
        <Scripts />
      </body>
    </html>
  );
}
