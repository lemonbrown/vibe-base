import { NavLink, Outlet, useLocation } from "react-router-dom";
import { classNames } from "../lib/format";

function GridIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M4 4h6v6H4V4zm10 0h6v6h-6V4zM4 14h6v6H4v-6zm10 0h6v6h-6v-6z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function ChatIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M4 5h16v11H9l-4 3.5V16H4V5z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const NAV = [
  { to: "/", label: "Apps", icon: GridIcon, match: (p: string) => p === "/" || p.startsWith("/apps") },
  { to: "/chat", label: "Chat", icon: ChatIcon, match: (p: string) => p.startsWith("/chat") },
];

function Brand() {
  return (
    <span className="text-sm font-semibold tracking-wide">
      <span className="text-[var(--color-brand)]">Vibe</span> Base
    </span>
  );
}

function SignOut() {
  return (
    <form method="post" action="/logout" className="m-0">
      <button className="text-sm text-[var(--color-muted)] hover:text-[var(--color-text)]">
        Sign out
      </button>
    </form>
  );
}

export function AppShell() {
  const { pathname } = useLocation();
  return (
    <div className="min-h-full">
      {/* Top bar */}
      <header className="sticky top-0 z-20 border-b border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-bg)_88%,transparent)] backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-6">
            <Brand />
            <nav className="hidden items-center gap-1 sm:flex">
              {NAV.map((n) => (
                <NavLink
                  key={n.to}
                  to={n.to}
                  className={classNames(
                    "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                    n.match(pathname)
                      ? "bg-[var(--color-brand-soft)] text-[var(--color-text)]"
                      : "text-[var(--color-muted)] hover:text-[var(--color-text)]"
                  )}
                >
                  {n.label}
                </NavLink>
              ))}
            </nav>
          </div>
          <SignOut />
        </div>
      </header>

      {/* Content — bottom padding leaves room for the mobile tab bar. */}
      <main className="mx-auto max-w-5xl px-4 pb-24 pt-5 sm:px-6 sm:pb-12">
        <Outlet />
      </main>

      {/* Bottom tab bar (mobile only) */}
      <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-bg)_92%,transparent)] backdrop-blur sm:hidden">
        <div className="mx-auto flex max-w-5xl">
          {NAV.map((n) => {
            const active = n.match(pathname);
            const Icon = n.icon;
            return (
              <NavLink
                key={n.to}
                to={n.to}
                className={classNames(
                  "flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px] font-medium",
                  active ? "text-[var(--color-brand)]" : "text-[var(--color-muted)]"
                )}
                style={{ paddingBottom: "calc(0.625rem + env(safe-area-inset-bottom))" }}
              >
                <Icon className="h-5 w-5" />
                {n.label}
              </NavLink>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
