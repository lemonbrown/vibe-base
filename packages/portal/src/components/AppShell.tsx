import { useEffect, useState } from "react";
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
function GearIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M12 2.5l1.6 2.2 2.7-.5 1 2.6 2.4 1.3-.6 2.7L20.5 14l-1.4 2.4.6 2.7-2.4 1.3-1 2.6-2.7-.5L12 21.5l-1.6-2.2-2.7.5-1-2.6L4.3 16l.6-2.7L3.5 11l1.4-2.4-.6-2.7 2.4-1.3 1-2.6 2.7.5L12 2.5z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
        opacity="0.5"
      />
    </svg>
  );
}
function PeopleIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <circle cx="9" cy="7" r="3" stroke="currentColor" strokeWidth="1.7" />
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="17" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.5" opacity="0.6" />
      <path d="M21 20c0-2.8-1.8-5-4-5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.6" />
    </svg>
  );
}

const NAV = [
  { to: "/", label: "Apps", icon: GridIcon, match: (p: string) => p === "/" || p.startsWith("/apps") },
  { to: "/chat", label: "Chat", icon: ChatIcon, match: (p: string) => p.startsWith("/chat") },
  { to: "/members", label: "Members", icon: PeopleIcon, match: (p: string) => p.startsWith("/members") },
  { to: "/settings", label: "Settings", icon: GearIcon, match: (p: string) => p.startsWith("/settings") },
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
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine
  );

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

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

      {!online && (
        <div className="border-b border-[#57401b] bg-[#1f1608] px-4 py-2 text-center text-xs font-medium text-[var(--color-warn)]">
          Offline. The portal shell is available, but live app data and actions require the VPS.
        </div>
      )}

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
